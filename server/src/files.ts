import { promises as fs } from "fs";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";

export type uri = string;

// listFiles recursively searches the filesystem path `p` for files, returning
// them as a list of absolute uris.
export async function listFiles(p: string): Promise<string[]> {
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
export function stripFileProtocol(uri: string): string {
  const fileProtocolPrefix = "file://";
  if (uri.startsWith(fileProtocolPrefix)) {
    return uri.substr(fileProtocolPrefix.length);
  }
  return uri;
}

// loadFromFilesystem creates a `TextDocument` from a local uri.
export async function loadFromFilesystem(uri: uri): Promise<TextDocument> {
  const content = await fs.readFile(stripFileProtocol(uri), "utf8");
  return TextDocument.create(uri, "kind", 0, content);
}
