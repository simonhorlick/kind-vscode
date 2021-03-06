// import { TextDocumentChangeEvent } from "vscode-languageserver";
// import { TextDocument } from "vscode-languageserver-textdocument";
// import { parse } from "./fm";

// const { parentPort, workerData, threadId } = require("worker_threads");

// console.log(`starting worker`);

// interface Change {
//   uri: string;
//   version: number;
//   text: string;
// }

// // a deliberately inefficient implementation of the fibonacci sequence
// function fibonacci(n: number): number {
//   if (n < 2) return n;
//   return fibonacci(n - 2) + fibonacci(n - 1);
// }

// let queue: Change[] = [];

// parentPort.on("message", (message: Change) => {
//   console.log(`parentPort: received message`);
//   queue.push(message);
//   // Atomics.store(int32, 0, 123);
//   // Atomics.notify(int32, 0, 1);

//   // This is now on the worker thread.
// });

// // const sab = new SharedArrayBuffer(1024);
// // const int32 = new Int32Array(sab);

// let done = false;

// const eventLoopQueue = () => {
//   return new Promise((resolve) =>
//     // setImmediate(() => {
//     //   // console.log("event loop");
//     //   resolve(null);
//     // })
//     setTimeout(() => {
//       // console.log("event loop");
//       resolve(null);
//     }, 100)
//   );
// };

// const run = async () => {
//   while (!done) {
//     // console.log("loop");

//     const e = queue.pop();
//     if (e != undefined) {
//       for (const q of queue) {
//         console.log(`skipping ${q.uri} ${q.version}`);
//       }
//       queue = [];

//       console.log(`handling ${e.uri} ${e.version}`);

//       // Parse the changes in this file.
//       const val = parse(e.uri, e.text);
//       definitions.set(e.uri, val);

//       // Typecheck and send diagnostics to the UI.
//       let diagnostics = computeDiagnostics();
//       for (const [uri, diag] of diagnostics.entries()) {
//         connection.sendDiagnostics({
//           uri: uri,
//           diagnostics: diag,
//           version: change.document.version,
//         });
//       }

//       parentPort.postMessage(`handled version ${e.version}`);
//     }

//     await eventLoopQueue();
//   }
// };

// run().then(() => console.log("Done"));
