import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  WorkspaceFolder,
  Range,
  TextDocumentPositionParams,
  CompletionItem,
  HoverParams,
  MarkupContent,
  MarkupKind,
  Diagnostic,
} from "vscode-languageserver";
import { DiagnosticSeverity } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import {
  computeDiagnostics,
  listToArray,
  parse,
  find_base_dir,
  LspResponse,
} from "./fm";
import { listFiles, loadFromFilesystem, stripFileProtocol, uri } from "./files";
const fm = require("./kind.js");

// global variables
let sources   = new Map<uri, TextDocument>();
let kind_defs = fm["BitsMap.new"]; /* Fm.Defs */
let lsp_defs  = fm["BBT.tip"]; /* Fm.Defs */

// connection handles messages between this LSP server and the client.
let connection = createConnection(ProposedFeatures.all);

// Notify the LSP client what capabilities this server provides.
connection.onInitialize(async (params) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      completionProvider: {
        resolveProvider: true,
      },
      hoverProvider: true,
    },
  };
});

// documents stores the contents of all documents that are open in the
// editor. Changes are sent from the editor incrementally and are resolved by
// TextDocuments.
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Handle files being opened in the editor.
documents.onDidOpen(async (event) => {
  // If the file is open in the editor its contents are taken from
  // `documents` instead of `filesystemSources`.
  sources.delete(event.document.uri);
});

function lspResponseToDiagnostic(
  textDocument: TextDocument,
  response: LspResponse
): Diagnostic {
  console.log(response.from);
  console.log(response.upto);
  return {
    severity: response.severity,
    range: {
      start: textDocument.positionAt(response.from),
      end: textDocument.positionAt(response.upto),
    },
    message: response.message,
    source: "Kind",
  };
}

function resolveDiagnostics(
  diagnostics: LspResponse,
  documents: TextDocuments<TextDocument>,
  defs_array: any
): Map<uri, Diagnostic[]> {
  const diagnostics_array: LspResponse[] =
    listToArray<LspResponse>(diagnostics);

  const result = new Map<uri, Diagnostic[]>();
  const files_diagnostics_map = new Map<uri, LspResponse[]>();

  for (const diagnostic of diagnostics_array) {
    const uri = diagnostic.file;
    const arr = files_diagnostics_map.get(diagnostic.file) ?? [];
    const upd = arr.concat([diagnostic]);
    const s_uri = !uri.startsWith("file://") ? "file://".concat(uri) : uri;
    const doc = documents.get(s_uri);
    const diagnostics = result.get(uri) ?? [];
    const new_diagnostics = diagnostics.concat(
      lspResponseToDiagnostic(doc!, diagnostic)
    );
    files_diagnostics_map.set(diagnostic.file, upd);
    result.set(uri, new_diagnostics);
  }

  for (const def of defs_array) {
    const uri = def.file;
    const diagnostics = files_diagnostics_map.get(uri);
    if (diagnostics == undefined) {
      result.set(uri, []);
    }
  }

  return result;
}

// Handle file edits by running the typechecker.
documents.onDidChangeContent(async (change) => {
  const uri = change.document.uri;
  const s_uri = uri.startsWith("file://") ? uri.substr(7) : uri;
  const code = change.document.getText();
  const response = await fm.run(fm["Lsp.on_change"](s_uri)(code)(kind_defs));

  const diagnostics = response.diagnostics;
  kind_defs = response.kind_defs;
  lsp_defs = response.lsp_defs;

  const defs_array = listToArray(fm["BitsMap.values"](kind_defs));

  const result = resolveDiagnostics(diagnostics, documents, defs_array);

  for (const [uri, diag] of result.entries()) {
    connection.sendDiagnostics({
      uri: uri,
      diagnostics: diag,
      version: change.document.version,
    });
  }

  console.log("handled change");
});

documents.onDidClose(async (e) => {
  // The document is no longer available from `documents`, so retrieve the
  // saved version from the filesystem.
  let doc = await loadFromFilesystem(e.document.uri);
  sources.set(e.document.uri, doc);
});

// Look up the definition of the symbol at the given source position.
connection.onDefinition((what) => {
  const start = process.hrtime.bigint();

  const uri = what.textDocument.uri;
  const doc = documents.get(uri);
  if (doc == undefined) {
    console.log(`document not found: ${uri}`);
    return null;
  }
  const offset = doc.offsetAt(what.position);

  let maybe = fm["Lsp.definition"](uri)(offset)(kind_defs);
  if (maybe._ == "Maybe.none") {
    return null;
  }

  const term /* Fm.Def */ = maybe.value;

  // Compute the source range of the term in the referenced file using the
  // offset in `term.orig`.
  let targetDoc = TextDocument.create(term.file, "fm", 0, term.code);
  const range = Range.create(
    targetDoc.positionAt(Number(term.orig.fst)),
    targetDoc.positionAt(Number(term.orig.snd))
  );

  console.log(
    `handled references in ${Number(process.hrtime.bigint() - start) / 1e6}ms`
  );

  return [
    {
      uri: term.file,
      range: range,
    },
  ];
});

function getHoveredWord(text: string, offset: number): string | undefined {
  const isSpace = (c: string) => /\s|\(|\)|\{|\}|<|>|,|!/.exec(c);
  let result = "";
  let lft = offset - 1;
  let rgt = offset;

  while (lft >= 0 && !isSpace(text[lft])) {
    result = text[lft] + result;
    lft -= 1;
  }
  lft = Math.max(0, lft + 1);

  while (rgt < text.length && !isSpace(text[rgt])) {
    result = result + text[rgt];
    rgt += 1;
  }
  rgt = Math.max(lft, rgt);

  return result === "" ? undefined : result;
}

connection.onHover((params: HoverParams) => {
  console.log(
    `hover request for ${params.textDocument.uri} position ${params.position.line} ${params.position.character}`
  );

  // Find whatever is under the cursor at this location.
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (doc == undefined) {
    console.log(`document not found: ${uri}`);
    return null;
  }
  const doc_text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const name = getHoveredWord(doc_text, offset);
  if (name == undefined) {
    console.log("word not found");
    return null;
  }
  let hover_refs = fm["Lsp.on_hover"](uri)(offset)(name)(lsp_defs);
  if (hover_refs._ == "Maybe.none") {
    return null;
  } else {
    hover_refs = hover_refs.value;
  }

  let markdown: MarkupContent = {
    kind: MarkupKind.Markdown,
    value: markdown_typescript_wrapper(hover_refs),
  };
  return { contents: markdown };
});

function markdown_typescript_wrapper(str: string): string {
  return `
\`\`\`typescript
${str}
\`\`\`\n`;
}

function display(f: any): string {
  if (f.term._ == "Kind.Term.app") return "";
  if (f.term._ == "Kind.Term.typ") return "";
  if (f.term._ == "Kind.Term.nat") return "";
  if (f.term._ == "Kind.Term.str") return "";
  if (f.term._ == "Kind.Term.chr") return "";

  return `
\`\`\`typescript
${printTerm(f.term, f.type)}
\`\`\``;
}

function printTerm(term: any, type: any): string {
  switch (term._) {
    case "Kind.Term.ref":
      return `${term.name}: ${fm["Kind.Term.show"](type.value)}`;
    case "Kind.Term.var":
      return `${term.name}: ${fm["Kind.Term.show"](type.value)}`;
    case "Kind.Term.nat":
      return `${term.natx}: ${fm["Kind.Term.show"](type.value)}`;
    case "Kind.Term.str":
      return `"${term.strx}": ${fm["Kind.Term.show"](type.value)}`;
    default:
      return `${term._} ${term.name ?? ""}`;
  }
}

connection.onDidOpenTextDocument((params) => {
  console.log("INSIDE DID OPEN TEXT DOCUMENT");
  console.log(params.textDocument);
  return "TEST 1";
});

connection.onDidSaveTextDocument((params) => {
  console.log("INSIDE SAVE TEXT");
  console.log(params.textDocument);
  console.log(params.text);
  return "TEST 2";
});

// Provide a list of possible completions that the user can auto-complete.
// Currently we just return the names of all top-level definitions.
connection.onCompletion(
  (position: TextDocumentPositionParams): CompletionItem[] =>
    listToArray(
      fm["Lsp.on_completions"](position.textDocument.uri)(position.position)(
        kind_defs
      )
    )
);

// This handler resolves additional information for the item selected in
// the completion list. There's currently no additional information so just
// return the original completion unchanged.
connection.onCompletionResolve((item) => item);

// Handle document change events.
documents.listen(connection);

// Listen for LSP clients.
connection.listen();
