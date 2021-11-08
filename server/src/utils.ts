import { Diagnostic, TextDocuments } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver-types";
import { uri } from "./files";

const fs = require("fs");
const path = require("path");
const kind = require("./kind.js");

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

// transform kind lsp response in
// typescript lsp diagnostic
export function lspResponseToDiagnostic(
  textDocument: TextDocument,
  response: LspResponse
): Diagnostic {
  const start = textDocument.positionAt(response.from);
  const end = textDocument.positionAt(response.upto);
  return {
    severity: response.severity,
    range: { start, end },
    message: response.message,
    source: "Kind",
  };
}

// transform kind lsp diagnostics and defs in
// typescript map: file => diagnostics
export function resolveDiagnostics(
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

// Locates the Kind/base dir and moves to it, or quits if it can't be found
let ADD_PATH = "";
export function find_base_dir(): string {
  const full_path = process.cwd();
  const local_dir = fs.readdirSync(".");
  const kind_indx = full_path.toLowerCase().indexOf("/kind/base");
  if (kind_indx !== -1) {
    if (kind_indx + 10 !== full_path.length) {
      ADD_PATH = `${full_path.slice(kind_indx + 10).slice(1)}/`;
    }
    process.chdir(full_path.slice(0, kind_indx + 10));
    return ADD_PATH;
    // } else if (local_dir.indexOf("kind") !== -1) {
    // process.chdir(path.join(full_path, "kind"));
    // find_base_dir();
    // } else if (local_dir.indexOf("Kind") !== -1) {
    // process.chdir(path.join(full_path, "Kind"));
    // find_base_dir();
  }
  if (
    local_dir.indexOf("base") !== -1 &&
    full_path.slice(-5).toLowerCase() === "/kind"
  ) {
    process.chdir(path.join(full_path, "base"));
    find_base_dir();
    return ADD_PATH;
    // } else {
    // console.log("# Kind "+require("./../package.json").version);
    // console.log("Couldn't find Kind/base directory.\n");
    // console.log("Go to the directory to run Kind commands or clone the repository:");
    // console.log("  git clone https://github.com/uwu-tech/Kind");
    // console.log("New files must be added inside Kind/base directory.");
    // process.exit();
  }
  return ADD_PATH;
}

// given a string and a position
// finds the word that contains this position
export function getHoveredWord(
  text: string,
  offset: number
): string | undefined {
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
    result += text[rgt];
    rgt += 1;
  }
  rgt = Math.max(lft, rgt);

  return result === "" ? undefined : result;
}

// pass text to typescript markdown
export function markdownTypescriptWrapper(str: string): string {
  return `
\`\`\`typescript
${str}
\`\`\`\n`;
}
