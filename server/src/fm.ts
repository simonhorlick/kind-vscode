import { Diagnostic } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver-types";
import { uri } from "./files";

const kind = require("kind.js");

export function parse(uri: string, content: string): any {
  return kind["Kind.Parser.file"](uri)(content)(kind["BitsMap.new"])(BigInt(0))(
    content
  );
}

// listToArray converts a kind-js List into a javascript Array.
// This function assumes details about the runtime representation of Lists
// that may not hold if kind-js is changed. A better way would be for
// the LSP to communicate with Kind via a standard encoding such as JSON
// or protobuf.
export function listToArray<T>(list: any): T[] {
  let result = [];
  switch (list._) {
    case "List.cons":
      result.push(list.head);
      result = result.concat(listToArray(list.tail));
      break;
  }
  return result;
}

export interface LspResponse {
  message: string;
  severity: DiagnosticSeverity;
  file: string;
  from: number;
  upto: number;
}

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
export function computeDiagnostics(
  report: any,
  documents: (x: any) => TextDocument | undefined,
  sources: Map<string, TextDocument>,
  defs: any
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
  for (const d of listToArray(kind["BitsMap.values"](defs))) {
    let uri = (d as any).file;
    let errs = reports.get(uri);
    if (errs == undefined) {
      result.set(uri, []);
    } else {
      let doc = documents(uri);
      if (doc == undefined) {
        doc = sources.get(uri);
      }
      result.set(uri, lspResponseToDiagnostics(doc!, errs));
    }
  }
  return result;
}
