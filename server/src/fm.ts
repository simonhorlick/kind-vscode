const fm = require("formality-js/src/formality.js");

export function parse(uri: string, content: string): any {
  const start = process.hrtime.bigint();
  const parsed = fm["Fm.Parser.file"](uri)(content)(fm["Map.new"])(BigInt(0))(
    content
  );
  switch (parsed._) {
    case "Parser.Reply.value":
      // idx: Nat, code: String, val: Map(Fm.Def)
      console.log(
        `parsed file ${uri} in ${
          Number(process.hrtime.bigint() - start) / 1e6
        }ms`
      );

      return parsed.val;
    case "Parser.Reply.error":
      // FIXME: Handle parse errors properly.
      console.log(`parse error: ${parsed.err}`);
      break;
    default:
      throw "unhandled case";
  }
}

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

// toJavascriptArray converts a formality-js List into a javascript Array.
// This function assumes details about the runtime representation of Lists
// that may not hold if formality-js is changed. A better way would be for
// the LSP to communicate with Formality via a standard encoding such as JSON
// or protobuf.
export function toJavascriptArray(list: any): LspResponse[] {
  let result: LspResponse[] = [];
  let iterator = list;
  while (iterator._ == "List.cons") {
    result.push({
      message: iterator.head.message,
      file: iterator.head.file,
      from: Number(iterator.head.from), // Convert BigInt to Number.
      upto: Number(iterator.head.upto),
    });
    iterator = iterator.tail;
  }
  return result;
}
