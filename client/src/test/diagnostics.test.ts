/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from "vscode";
import * as assert from "assert";
import { getDocUri, activate } from "./helper";

suite("diagnostics", () => {
  const docUri = getDocUri("diagnostics.fm");

  test("should return an undefined reference error", async () => {
    await testDiagnostics(docUri, [
      {
        message:
          "Type mismatch.\n" +
          "- Expected: bool\n" +
          "- Detected: Bool\n" +
          "With context:\n" +
          "- a: Bool\n" +
          "- b: Bool\n",
        range: toRange(27, 21, 27, 22),
        severity: vscode.DiagnosticSeverity.Error,
        source: "Formality",
      },
      {
        message: "Undefined reference: bool\n",
        range: toRange(6, 13, 6, 17),
        severity: vscode.DiagnosticSeverity.Error,
        source: "Formality",
      },
    ]);
  });
});

function toRange(sLine: number, sChar: number, eLine: number, eChar: number) {
  const start = new vscode.Position(sLine - 1, sChar - 1);
  const end = new vscode.Position(eLine - 1, eChar - 1);
  return new vscode.Range(start, end);
}

async function testDiagnostics(
  docUri: vscode.Uri,
  expectedDiagnostics: vscode.Diagnostic[]
) {
  await activate(docUri);

  const actualDiagnostics = vscode.languages.getDiagnostics(docUri);

  assert.equal(actualDiagnostics.length, expectedDiagnostics.length);

  expectedDiagnostics.forEach((expectedDiagnostic, i) => {
    const actualDiagnostic = actualDiagnostics[i];
    assert.equal(actualDiagnostic.message, expectedDiagnostic.message);
    assert.deepEqual(actualDiagnostic.range, expectedDiagnostic.range);
    assert.equal(actualDiagnostic.severity, expectedDiagnostic.severity);
  });
}
