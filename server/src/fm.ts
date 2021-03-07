import { DiagnosticSeverity } from "vscode-languageserver-types";

const kind = require("kind-lang/src/kind.js");

export function parse(uri: string, content: string): any {
  return kind["Kind.Parser.file"](uri)(content)(kind["Map.new"])(BigInt(0))(
    content
  );
}

export function values<T>(map: any): T[] {
  let result = [];
  switch (map._) {
    case "Map.tie":
      if (map.val._ != "Maybe.none") {
        result.push(map.val.value);
      }
      result = result.concat(values(map.lft), values(map.rgt));
      break;
  }
  return result;
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
