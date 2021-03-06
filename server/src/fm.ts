const fm = require("formality-js/src/formality.js");

export function parse(uri: string, content: string): any {
  return fm["Fm.Parser.file"](uri)(content)(fm["Map.new"])(BigInt(0))(content);
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

// listToArray converts a formality-js List into a javascript Array.
// This function assumes details about the runtime representation of Lists
// that may not hold if formality-js is changed. A better way would be for
// the LSP to communicate with Formality via a standard encoding such as JSON
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
  file: string;
  from: number;
  upto: number;
}
