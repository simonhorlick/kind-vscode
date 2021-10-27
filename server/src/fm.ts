import { Diagnostic } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver-types";
import { uri } from "./files";

const kind = require("./kind.js");
const fs = require("fs");
const path = require("path");

export function parse(uri: string, content: string): any {
  const initial_state = kind["Parser.State.new"](kind["Maybe.none"])("")(
    BigInt(0)
  )(BigInt(0))(content);
  return kind["Kind.Parser.file"](uri)(content)(kind["BitsMap.new"])(
    initial_state
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
export function lspResponseToDiagnostics(
  textDocument: TextDocument,
  res: LspResponse[]
): Diagnostic[] {
  return res.map((response) => {
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
  });
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
      if (!uri.startsWith("file://")) uri = "file://".concat(uri);
      let doc = documents(uri);
      if (doc == undefined) doc = sources.get(uri);
      console.log(uri);
      console.log(doc!);
      result.set(uri, lspResponseToDiagnostics(doc!, errs));
    }
  }
  return result;
}

// Locates the Kind/base dir and moves to it, or quits if it can't be found
var ADD_PATH = "";
export function find_base_dir(): string {
  var full_path = process.cwd();
  var local_dir = fs.readdirSync(".");
  var kind_indx = full_path.toLowerCase().indexOf("/kind/base");
  if (kind_indx !== -1) {
    if (kind_indx + 10 !== full_path.length) {
      ADD_PATH = full_path.slice(kind_indx + 10).slice(1) + "/";
    }
    process.chdir(full_path.slice(0, kind_indx + 10));
    return ADD_PATH;
    //} else if (local_dir.indexOf("kind") !== -1) {
    //process.chdir(path.join(full_path, "kind"));
    //find_base_dir();
    //} else if (local_dir.indexOf("Kind") !== -1) {
    //process.chdir(path.join(full_path, "Kind"));
    //find_base_dir();
  } else if (
    local_dir.indexOf("base") !== -1 &&
    full_path.slice(-5).toLowerCase() === "/kind"
  ) {
    process.chdir(path.join(full_path, "base"));
    find_base_dir();
    return ADD_PATH;
    //} else {
    //console.log("# Kind "+require("./../package.json").version);
    //console.log("Couldn't find Kind/base directory.\n");
    //console.log("Go to the directory to run Kind commands or clone the repository:");
    //console.log("  git clone https://github.com/uwu-tech/Kind");
    //console.log("New files must be added inside Kind/base directory.");
    //process.exit();
  }
  return ADD_PATH;
}
