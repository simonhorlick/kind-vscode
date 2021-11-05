import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  Range,
  HoverParams,
  MarkupContent,
  MarkupKind,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  listToArray,
  resolveDiagnostics,
  markdownTypescriptWrapper,
  getHoveredWord
} from "./utils";
import { loadFromFilesystem, uri } from "./files";

// GLOBAL VARIABLES
const kind = require("./kind.js");
let kind_defs = kind["BitsMap.new"];
let lsp_defs = kind["BBT.tip"];
const sources = new Map<uri, TextDocument>();

// documents stores the contents of all documents that are open in the
// editor. Changes are sent from the editor incrementally and are resolved by
// TextDocuments.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// connection handles messages between this LSP server and the client.
const connection = createConnection(ProposedFeatures.all);

// HANDLERS
// Notify the LSP client what capabilities this server provides.
connection.onInitialize(async (params) => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    definitionProvider: true,
    completionProvider: {
      resolveProvider: true,
    },
    hoverProvider: true,
  },
}));

// Handle files being opened in the editor.
documents.onDidOpen(async (event) => {
  // If the file is open in the editor its contents are taken from
  // `documents` instead of `filesystemSources`.
  sources.delete(event.document.uri);
});

// Handle file edits by running the typechecker.
documents.onDidChangeContent(async (change) => {
  // get doc info
  const { uri } = change.document;
  const s_uri = uri.startsWith("file://") ? uri.substr(7) : uri;
  const code = change.document.getText();

  // process doc check
  const response = await kind.run(
    kind["Lsp.on_change"](s_uri)(code)(kind_defs)
  );
  const { diagnostics } = response;
  kind_defs = response.kind_defs;
  lsp_defs = response.lsp_defs;

  // lil transformations: kind result > lsp result
  const defs_array = listToArray(kind["BitsMap.values"](kind_defs));
  const result = resolveDiagnostics(diagnostics, documents, defs_array);

  // return responses
  for (const [uri, diag] of result.entries()) {
    connection.sendDiagnostics({
      uri,
      diagnostics: diag,
      version: change.document.version,
    });
  }
});

documents.onDidClose(async (e) => {
  // The document is no longer available from `documents`, so retrieve the
  // saved version from the filesystem.
  const doc = await loadFromFilesystem(e.document.uri);
  sources.set(e.document.uri, doc);
});

// Look up the definition of the symbol at the given source position.
connection.onDefinition((what) => {
  const start = process.hrtime.bigint();

  const { uri } = what.textDocument;
  const doc = documents.get(uri);
  if (doc == undefined) {
    console.log(`document not found: ${uri}`);
    return null;
  }
  const offset = doc.offsetAt(what.position);

  const maybe = kind["Lsp.on_definition"](uri)(offset)(kind_defs);
  if (maybe._ == "Maybe.none") {
    return null;
  }

  const term /* Fm.Def */ = maybe.value;

  // Compute the source range of the term in the referenced file using the
  // offset in `term.orig`.
  const targetDoc = TextDocument.create(term.file, "fm", 0, term.code);
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
      range,
    },
  ];
});

connection.onHover((params: HoverParams) => {
  console.log(
    `hover request for ${params.textDocument.uri} position ${params.position.line} ${params.position.character}`
  );

  // Find whatever is under the cursor at this location.
  const { uri } = params.textDocument;
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
  let hover_refs = kind["Lsp.on_hover"](uri)(offset)(name)(lsp_defs);
  if (hover_refs._ == "Maybe.none") {
    return null;
  }
  hover_refs = hover_refs.value;

  const markdown: MarkupContent = {
    kind: MarkupKind.Markdown,
    value: markdownTypescriptWrapper(hover_refs),
  };
  return { contents: markdown };
});

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
connection.onCompletion((position) =>
  listToArray(
    kind["Lsp.on_completions"](position.textDocument.uri)(position.position)(
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
