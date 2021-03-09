# kind-vscode

A Visual Studio Code plugin for the Kind programming language. This plugin provides output from the kind typechecker to VSCode.

![Screenshot of the plugin displaying a diagnostic message](https://github.com/simonhorlick/kind-vscode/raw/main/example.png)

## Architecture

![A architecture diagram showing the high level components](https://github.com/simonhorlick/kind-vscode/raw/main/architecture.jpg)

This extension is structured as three pieces:

- A vscode extension that launches kind-lsp
- A language server, kind-lsp, that's written in node and contains the state
- A set of functions for computing results, written in Kind.

## Structure

```
.
├── client // Language Client
│   ├── src
│   │   ├── test // End to End tests for Language Client / Server
│   │   └── extension.ts // Language Client entry point
├── package.json // The extension manifest.
└── server // Language Server
    └── src
        └── server.ts // Language Server entry point
```

## Getting Started

To install all of the necessary dependencies, run

```bash
npm install
```

In VSCode there is a launch configuration named "Launch Client" that will start an instance of VSCode with the plugin enabled.

## Roadmap

The following features are planned:

- [ ] Hover over a symbol to view its documentation
- [x] Jump to definition
- [ ] Autocompletion
- [ ] Rename symbol
- [ ] Support for other editors, for example: Atom, vim
