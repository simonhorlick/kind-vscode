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
  Hover,
  MarkupContent,
  MarkupKind,
} from "vscode-languageserver";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { listToArray, LspResponse, parse, values } from "./fm";

import { listFiles, loadFromFilesystem, stripFileProtocol, uri } from "./files";

const fm = require("kind-lang/src/kind.js");

// connection handles messages between this LSP server and the client.
let connection = createConnection(ProposedFeatures.all);

let sources = new Map<uri, TextDocument>();
let defs = fm["Map.new"]; /* Fm.Defs */

let initialCheck = false;

connection.onInitialized(async () => {
  for (const workspace of workspaceFolders) {
    // Load all sources under each of the workspaces.
    console.log(`checking workspace: ${workspace.name}`);

    let workspaceFiles = await listFiles(stripFileProtocol(workspace.uri));
    let sourceFiles = workspaceFiles.filter((file) => file.endsWith(".kind"));

    // Read all source files into memory.
    for (const filename of sourceFiles) {
      let doc = await loadFromFilesystem(filename);
      sources.set(filename, doc);

      // TODO(simon): Parse files in parallel using a pool of workers as this
      // is CPU-bound.
      const parsed = parse(filename, doc.getText());
      switch (parsed._) {
        case "Parser.Reply.value":
          defs = fm["Map.union"](parsed.val)(defs);
          break;
        case "Parser.Reply.error":
          console.log(`parse error: ${parsed.err}`);
          // Send parse errors to the UI.
          connection.sendDiagnostics({
            uri: doc.uri,
            diagnostics: [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: doc.positionAt(Number(parsed.idx)),
                  end: doc.positionAt(Number(parsed.idx)),
                },
                message: parsed.err,
                source: "Kind",
              },
            ],
            version: doc.version,
          });

          break;
        default:
          throw "unhandled case";
      }
    }

    const names = fm["List.mapped"](fm["Map.keys"](defs))(
      fm["Kind.Name.from_bits"]
    );

    const start = process.hrtime.bigint();
    defs = fm["IO.purify"](fm["Kind.Synth.many"](names)(defs));
    console.log(
      `synth took ${Number(process.hrtime.bigint() - start) / 1e6}ms`
    );

    const report = fm["Lsp.diagnostics"](defs);

    // Display an initial set of diagnostics.
    let diagnostics = computeDiagnostics(report, documents, sources);
    for (const [uri, diag] of diagnostics.entries()) {
      connection.sendDiagnostics({ uri: uri, diagnostics: diag, version: 0 });
    }

    initialCheck = true;
  }
});

var workspaceFolders: WorkspaceFolder[];

connection.onInitialize(async (params) => {
  if (params.workspaceFolders) {
    workspaceFolders = params.workspaceFolders;
  }

  // Notify the LSP client what capabilities this server provides.
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

// Handle file edits by running the typechecker.
documents.onDidChangeContent((change) => {
  if (!initialCheck) return;

  const startChange = process.hrtime.bigint();

  const pair = fm["Lsp.on_change"](change.document.uri)(
    change.document.getText()
  )(defs);

  defs = pair.fst;
  const report = pair.snd;

  let result = computeDiagnostics(report, documents, sources);

  for (const [uri, diag] of result.entries()) {
    connection.sendDiagnostics({
      uri: uri,
      diagnostics: diag,
      version: change.document.version,
    });
  }

  console.log(
    `handled change in ${Number(process.hrtime.bigint() - startChange) / 1e6}ms`
  );
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

  let maybe = fm["Lsp.definition"](uri)(offset)(defs);
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
  const offset = doc.offsetAt(params.position);

  let maybe = fm["Lsp.on_hover"](uri)(offset)(defs);
  if (maybe._ == "Maybe.none") {
    return null;
  }

  const list = listToArray(maybe);

  const validSources = list.filter((x: any) => x.range.value != undefined);

  const matches = validSources.filter(
    (x: any) => offset >= x.range.value.fst && offset < x.range.value.snd
  );

  if (matches.length == 0) return null;

  const messages = new Set<String>();

  matches
    .map((x) => display(x))
    .filter((x) => x.length > 0)
    // de-duplicate - this can happen in '_' cases of case expressions.
    .forEach((x) => messages.add(x));

  if (messages.size == 0) return null;

  let markdown: MarkupContent = {
    kind: MarkupKind.Markdown,
    value: Array.from(messages.values()).join("\n"),
  };
  return { contents: markdown };
});

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

// Provide a list of possible completions that the user can auto-complete.
// Currently we just return the names of all top-level definitions.
connection.onCompletion(
  (position: TextDocumentPositionParams): CompletionItem[] =>
    listToArray(
      fm["Lsp.on_completions"](position.textDocument.uri)(position.position)(
        defs
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

// lspResponseToDiagnostics adapts an `LspResponse` into a `Diagnostic`.
function lspResponseToDiagnostics(
  textDocument: TextDocument,
  res: LspResponse[]
): Diagnostic[] {
  return res.map((response) => ({
    severity: response.severity,
    range: {
      start: textDocument.positionAt(response.from),
      end: textDocument.positionAt(response.upto),
    },
    message: response.message,
    source: "Kind",
  }));
}

// computeDiagnostics typechecks everything and sends the report as
// diagnostics to the client.
function computeDiagnostics(
  report: any,
  documents: TextDocuments<TextDocument>,
  sources: Map<string, TextDocument>
): Map<uri, Diagnostic[]> {
  // group by uri: LspResponse[] -> Map(uri, LspResponse[])
  let reports = new Map<string, LspResponse[]>();
  for (const r of listToArray<LspResponse>(report)) {
    let arr = reports.get(r.file) ?? [];
    let upd = arr.concat([r]);
    reports.set(r.file, upd);
  }

  let result = new Map<uri, Diagnostic[]>();

  // We must also send empty reports for files that no longer have any
  // diagnostics to display. So iterate over all files we know about.
  for (const d of values(defs)) {
    let uri = (d as any).file;
    let errs = reports.get(uri);
    if (errs == undefined) {
      result.set(uri, []);
    } else {
      let doc = documents.get(uri);
      if (doc == undefined) {
        doc = sources.get(uri);
      }
      result.set(uri, lspResponseToDiagnostics(doc!, errs));
    }
  }
  return result;
}
