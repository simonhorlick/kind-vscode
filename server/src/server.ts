import { promises as fs } from "fs";
import * as path from "path";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  WorkspaceFolder,
} from "vscode-languageserver";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { LspResponse, parse, toJavascriptArray } from "./fm";

const fm = require("formality-js/src/formality.js");

// connection handles messages between this LSP server and the client.
let connection = createConnection(ProposedFeatures.all);

// listFiles recursively searches the filesystem path `p` for files, returning
// them as a list of absolute uris.
async function listFiles(p: string): Promise<string[]> {
  const entries = await fs.readdir(p, { withFileTypes: true });

  var result: string[] = [];

  const files = entries
    .filter((entry) => !entry.isDirectory())
    .map((file) => "file://" + path.join(p, file.name));

  const dirs = entries.filter((entry) => entry.isDirectory());

  for (const directory of dirs) {
    var d = await listFiles(path.join(p, directory.name));
    result = result.concat(d);
  }

  result = result.concat(files);

  return result;
}

// stripFileProtocol strips the protocol prefix from the uri if it is the
// file: protocol. If not the uri is returned unchanged.
function stripFileProtocol(uri: string): string {
  const fileProtocolPrefix = "file://";
  if (uri.startsWith(fileProtocolPrefix)) {
    return uri.substr(fileProtocolPrefix.length);
  }
  return uri;
}

type uri = string;
let filesystemSources = new Map<uri, TextDocument>();
let definitions = new Map<uri, any /* Fm.Defs */>();

// loadFromFilesystem creates a `TextDocument` from a local uri.
async function loadFromFilesystem(uri: uri): Promise<TextDocument> {
  console.log(`loading ${uri}`);
  const content = await fs.readFile(stripFileProtocol(uri), "utf8");
  return TextDocument.create(uri, "fm", 0, content);
}

connection.onInitialized(async () => {
  for (const workspace of workspaceFolders) {
    // Load all Formality sources under each of the workspaces.
    console.log(`checking workspace: ${workspace.name}`);

    let workspaceFiles = await listFiles(stripFileProtocol(workspace.uri));
    let sources = workspaceFiles.filter((file) => file.endsWith(".fm"));

    // Read all source files into memory.
    for (const filename of sources) {
      let doc = await loadFromFilesystem(filename);
      filesystemSources.set(filename, doc);

      // FIXME: Display parse errors.
      const val = parse(filename, doc.getText());
      definitions.set(filename, val);
    }

    // Display an initial set of diagnostics.
    computeDiagnostics();
  }
});

// computeDiagnostics typechecks everything and sends the report as
// diagnostics to the client.
function computeDiagnostics() {
  const defs = mergeDefs(definitions);

  const names = fm["List.mapped"](fm["Map.keys"](defs))(
    fm["Fm.Name.from_bits"]
  );

  const synth = fm["IO.purify"](fm["Fm.Synth.many"](names)(defs));

  console.log(`synth complete`);

  const report = fm["LanguageServer.check"](synth);

  let reports = new Map<string, LspResponse[]>();
  for (const r of toJavascriptArray(report)) {
    let arr = reports.get(r.file) ?? [];
    let upd = arr.concat([r]);
    reports.set(r.file, upd);
  }

  console.log(`done, sending diagnostics`);

  // We must also send empty reports for files that no longer have any
  // diagnostics to display. So iterate over all files we know about.
  for (const uri of definitions.keys()) {
    let doc = documents.get(uri);
    if (doc == undefined) {
      doc = filesystemSources.get(uri);
    }
    let errs = reports.get(uri);
    if (errs == undefined) {
      connection.sendDiagnostics({ uri: doc!.uri, diagnostics: [] });
    } else {
      let diagnostics = lspResponseToDiagnostics(doc!, errs);
      connection.sendDiagnostics({ uri: doc!.uri, diagnostics });
    }
  }
}

var workspaceFolders: WorkspaceFolder[];

connection.onInitialize(async (params) => {
  if (params.workspaceFolders) {
    workspaceFolders = params.workspaceFolders;
  }

  // Notify the LSP client what capabilities this server provides.
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
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
  filesystemSources.delete(event.document.uri);
});

// Handle file edits by running the typechecker.
documents.onDidChangeContent(async (change) => {
  // Parse the changes in this file.
  const val = parse(change.document.uri, change.document.getText());
  definitions.set(change.document.uri, val);

  // Typecheck and send diagnostics to the UI.
  computeDiagnostics();
});

documents.onDidClose(async (e) => {
  // The document is no longer available from `documents`, so retrieve the
  // saved version from the filesystem.
  let doc = await loadFromFilesystem(e.document.uri);
  filesystemSources.set(e.document.uri, doc);
});

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
    severity: DiagnosticSeverity.Error,
    range: {
      start: textDocument.positionAt(response.from),
      end: textDocument.positionAt(response.upto),
    },
    message: response.message,
    source: "Formality",
  }));
}

// mergeDefs computes the union of all defs provided.
function mergeDefs(defs: Map<uri, any /* Fm.Defs */>): /* Fm.Defs */ any {
  var result = fm["Map.new"];
  for (const file of defs.keys()) {
    const def = defs.get(file);
    result = fm["Map.union"](result)(def);
  }
  return result;
}
