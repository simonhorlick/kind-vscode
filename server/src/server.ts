import { promises as fs } from "fs";
import * as path from "path";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  WorkspaceFolder,
  TextDocumentChangeEvent,
} from "vscode-languageserver";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import {
  listToArray,
  LspResponse,
  parse,
  toJavascriptArray,
  values,
} from "./fm";

import { Subject } from "rxjs";
import { debounceTime } from "rxjs/operators";

const fm = require("formality-js/src/formality.js");

var util = require("util");

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
let definitions2 = fm["Map.new"]; /* Fm.Defs */

let initialCheck = false;

// loadFromFilesystem creates a `TextDocument` from a local uri.
async function loadFromFilesystem(uri: uri): Promise<TextDocument> {
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

      // TODO(simon): Parse files in parallel using a pool of workers as this
      // is CPU-bound.
      const parsed = parse(filename, doc.getText());
      switch (parsed._) {
        case "Parser.Reply.value":
          definitions.set(doc.uri, parsed.val);
          definitions2 = fm["Map.union"](parsed.val)(definitions2);
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
                source: "Formality",
              },
            ],
            version: doc.version,
          });

          break;
        default:
          throw "unhandled case";
      }
    }

    // Display an initial set of diagnostics.
    let diagnostics = computeDiagnostics();
    for (const [uri, diag] of diagnostics.entries()) {
      connection.sendDiagnostics({ uri: uri, diagnostics: diag, version: 0 });
    }

    initialCheck = true;
  }
});

// computeDiagnostics typechecks everything and sends the report as
// diagnostics to the client.
function computeDiagnostics(): Map<uri, Diagnostic[]> {
  const defs = mergeDefs(definitions);

  const names = fm["List.mapped"](fm["Map.keys"](defs))(
    fm["Fm.Name.from_bits"]
  );

  const start = process.hrtime.bigint();
  const synth = fm["IO.purify"](fm["Fm.Synth.many"](names)(defs));
  definitions2 = synth;
  console.log(`synth took ${Number(process.hrtime.bigint() - start) / 1e6}ms`);

  const report = fm["LanguageServer.check"](synth);

  let reports = new Map<string, LspResponse[]>();
  for (const r of toJavascriptArray(report)) {
    let arr = reports.get(r.file) ?? [];
    let upd = arr.concat([r]);
    reports.set(r.file, upd);
  }

  console.log(`done, sending diagnostics`);

  let result = new Map<uri, Diagnostic[]>();

  // We must also send empty reports for files that no longer have any
  // diagnostics to display. So iterate over all files we know about.
  for (const uri of definitions.keys()) {
    let doc = documents.get(uri);
    if (doc == undefined) {
      doc = filesystemSources.get(uri);
    }
    let errs = reports.get(uri);
    if (errs == undefined) {
      result.set(doc!.uri, []);
    } else {
      result.set(doc!.uri, lspResponseToDiagnostics(doc!, errs));
    }
  }
  return result;
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

// documentChanges acts as a queue of file edits to be processed.
const documentChanges = new Subject<TextDocumentChangeEvent<TextDocument>>();

// The duration to wait during the debounce operation.
const checkDelayMillis = 150;

// When a file edit happens we wait for `checkDelayMillis` to see if
// any other edits happen within that time window. If more edits happen
// during the time span we reset the timer and discard older change events.
// Once we reach the end of the time span without any new events occuring we
// trigger a parse and typecheck. This ensures the user gets the most
// up-to-date results and that we don't waste resources checking files
// that are actively being edited.
//
// FIXME(simon): This will collapse edits to different files together - we
// need to ensure this doesn't happen.
documentChanges.pipe(debounceTime(checkDelayMillis)).subscribe((change) => {
  if (!initialCheck) return;

  const startChange = process.hrtime.bigint();

  // Parse the changes in this file.
  const parsed = parse(change.document.uri, change.document.getText());
  console.log(
    `parse took ${Number(process.hrtime.bigint() - startChange) / 1e6}ms`
  );

  let defsToCheck;

  switch (parsed._) {
    case "Parser.Reply.value":
      let oldDefs = definitions.get(change.document.uri);

      // console.log(values(definitions2));

      if (oldDefs != undefined) {
        // Remove defs that were deleted as part of this change.
        for (const bits of listToArray(fm["Map.keys"](oldDefs))) {
          definitions2 = fm["Map.delete"](bits)(definitions2);
        }
      }
      // console.log(values(definitions2));

      // console.log(`parsed file ${doc.uri}`);
      definitions.set(change.document.uri, parsed.val);
      defsToCheck = fm["List.mapped"](fm["Map.keys"](parsed.val))(
        fm["Fm.Name.from_bits"]
      );

      // console.log(
      //   `current defs are: ${listToArray(
      //     fm["List.mapped"](fm["Map.keys"](definitions2))(
      //       fm["Fm.Name.from_bits"]
      //     )
      //   ).join(", ")}`
      // );

      // console.log(values(definitions2));

      // for (const bits of listToArray(fm["Map.keys"](parsed.val))) {
      //   definitions2 = fm["Map.delete"](bits)(definitions2);
      // }

      // console.log(values(definitions2));
      // console.log(values(parsed.val));

      // beware of the order of args here - in case of a collision union takes the first argument.
      definitions2 = fm["Map.union"](parsed.val)(definitions2);
      // console.log(values(definitions2));

      console.log(`will re-check: ${listToArray(defsToCheck).join(", ")}`);
      break;
    case "Parser.Reply.error":
      console.log(`parse error: ${parsed.err}`);
      // Typecheck and send diagnostics to the UI.
      connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: {
              start: change.document.positionAt(Number(parsed.idx)),
              end: change.document.positionAt(Number(parsed.idx)),
            },
            message: parsed.err,
            source: "Formality",
          },
        ],
        version: change.document.version,
      });

      // No need to typecheck if there's a parse error.
      return;
    default:
      throw "unhandled case";
  }

  // Make a list of defs that need re-checking.
  //  - all defs in the changed file (better: the def that's been edited)
  //  - defs that reference the edited ones (the reverse deps)

  //// Typecheck and send diagnostics to the UI.
  // let diagnostics = computeDiagnostics();

  const startSynth = process.hrtime.bigint();
  definitions2 = fm["IO.purify"](
    fm["Fm.Synth.many"](defsToCheck)(definitions2)
  );
  console.log(
    `synth took ${Number(process.hrtime.bigint() - startSynth) / 1e6}ms`
  );

  const startReport = process.hrtime.bigint();

  const report = fm["LanguageServer.check"](definitions2);

  let reports = new Map<string, LspResponse[]>();
  for (const r of toJavascriptArray(report)) {
    let arr = reports.get(r.file) ?? [];
    let upd = arr.concat([r]);
    reports.set(r.file, upd);
  }

  let result = new Map<uri, Diagnostic[]>();

  // We must also send empty reports for files that no longer have any
  // diagnostics to display. So iterate over all files we know about.
  for (const uri of definitions.keys()) {
    let doc = documents.get(uri);
    if (doc == undefined) {
      doc = filesystemSources.get(uri);
    }
    let errs = reports.get(uri);
    if (errs == undefined) {
      result.set(doc!.uri, []);
    } else {
      result.set(doc!.uri, lspResponseToDiagnostics(doc!, errs));
    }
  }

  console.log(
    `report took ${Number(process.hrtime.bigint() - startReport) / 1e6}ms`
  );

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

  reverseDependencies("String.starts_with", definitions2);
});

function reverseDependencies(name: string, defs: any) {
  let defsl = values(defs);

  // Find all references.
  for (const def of defsl) {
    const d = def as any;
    if (d.name == "Example.fib") {
      let deps = fm["LanguageServer.dependencies"](d.term);
      console.log(deps);
    }
  }
}

// Handle file edits by running the typechecker.
documents.onDidChangeContent((change) => documentChanges.next(change));

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
    try {
      result = fm["Map.union"](def)(result);
    } catch (e) {
      console.error(e);
    }
  }
  return result;
}
