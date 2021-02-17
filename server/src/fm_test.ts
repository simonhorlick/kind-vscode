import { expect } from "chai";
import "mocha";

const fm = require("formality-js/src/formality.js");

const util = require("util");
//    console.log(util.inspect(defsArray, { depth: null }));

import { listToArray, parse, toJavascriptArray } from "./fm";

const boolSource = `
type Bool {
  true,
  false,
}
`;

const boolnotSource = `
Bool.not(a: Bool): Bool
  case a {
    true: false,
    false: true,
  }
`;

const incorrectBoolnotSource = `
Bool.not(a: Boll): Bool
  case a {
    true: false,
    false: true,
  }
`;

function traverse(node: any): Array<any> {
  switch (node._) {
    case "Map.new":
      return [];
    case "Map.tie":
      var results = [];
      switch (node.val._) {
        case "Maybe.none":
          break;
        case "Maybe.some":
          results.push(node.val.value);
          break;
      }

      results = results.concat(traverse(node.lft));
      results = results.concat(traverse(node.rgt));
      return results;
    default:
      throw "unhandled case";
  }
}

describe("fm", () => {
  it("should parse a type definition", () => {
    const val = parse("file:///Bool.fm", boolSource);
    expect(val._).to.equal("Map.tie");
  });

  it("should parse a function", () => {
    const val = parse("file:///Bool/not.fm", boolnotSource);
    expect(val._).to.equal("Map.tie");
  });

  it("should typecheck Bool.not", () => {
    const bool = parse("file:///Bool.fm", boolSource);
    const boolNot = parse("file:///Bool/not.fm", boolnotSource);

    var defs = fm["Map.new"];
    defs = fm["Map.union"](defs)(bool);
    defs = fm["Map.union"](defs)(boolNot);

    const names = fm["List.mapped"](fm["Map.keys"](defs))(
      fm["Fm.Name.from_bits"]
    );

    const namesArray = listToArray<string>(names);
    expect(namesArray).to.deep.equal([
      "Bool",
      "Bool.false",
      "Bool.not",
      "Bool.true",
    ]);

    const synth = fm["IO.purify"](fm["Fm.Synth.many"](names)(defs));

    console.log(`synth complete`);
    console.log(`checking`);

    const report = fm["LanguageServer.check"](synth);

    // If there are no diagnostics we'll get a nil List here.
    expect(report._).to.equal("List.nil");
  });

  it("should produce an undefined reference diagnostic if there's a typo", () => {
    const bool = parse("file:///Bool.fm", boolSource);
    const boolNot = parse("file:///Bool/not.fm", incorrectBoolnotSource);

    var defs = fm["Map.new"];
    defs = fm["Map.union"](defs)(bool);
    defs = fm["Map.union"](defs)(boolNot);

    const names = fm["List.mapped"](fm["Map.keys"](defs))(
      fm["Fm.Name.from_bits"]
    );

    const synth = fm["IO.purify"](fm["Fm.Synth.many"](names)(defs));

    const report = fm["LanguageServer.check"](synth);

    const reportArray = toJavascriptArray(report);

    const expected = {
      message: "Undefined reference: Boll\n",
      file: "file:///Bool/not.fm",
      from: 13,
      upto: 17,
    };

    expect(reportArray).to.not.be.empty;
    expect(reportArray[0]).to.deep.equal(expected);
  });
});
