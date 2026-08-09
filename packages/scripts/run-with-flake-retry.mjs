#!/usr/bin/env node
/**
 * Run a command once, and once more only when it fails with a known
 * infrastructure flake signature in its output. Exists for suites whose real
 * failures must stay loud while a named runner-level fault (e.g. Bun's
 * subprocess stdio wiring emitting `EEXIST … epoll_ctl` / `Failed to connect`
 * between tests) gets one bounded second chance. A failure that does not
 * match the signature is never retried.
 * Exit codes: the final attempt's own code, 127 when the command cannot
 * start, 2 on usage errors.
 *
 * usage: node packages/scripts/run-with-flake-retry.mjs <signature-regex> -- <command> [args...]
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const signatureRaw = argv[0] ?? "";
if (argv[1] !== "--" || !signatureRaw || argv.length < 3) {
  console.error(
    "usage: node packages/scripts/run-with-flake-retry.mjs <signature-regex> -- <command> [args...]",
  );
  process.exit(2);
}
let signature;
try {
  signature = new RegExp(signatureRaw);
} catch (error) {
  console.error(`[run-with-flake-retry] invalid signature regex: ${error.message}`);
  process.exit(2);
}
const [command, ...args] = argv.slice(2);

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    let tail = "";
    const capture = (chunk, sink) => {
      sink.write(chunk);
      // Only the tail is needed for signature matching; unbounded capture of a
      // chatty suite would hold the whole log in memory.
      tail = (tail + chunk.toString()).slice(-262144);
    };
    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.on("error", (error) => {
      console.error(
        `[run-with-flake-retry] failed to start "${command}": ${error.message}`,
      );
      resolve({ code: 127, tail });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), tail });
    });
  });
}

const first = await runOnce();
if (first.code === 0 || first.code === 127 || !signature.test(first.tail)) {
  process.exit(first.code);
}
console.error(
  `[run-with-flake-retry] exit ${first.code} matched flake signature ${signature}; retrying once`,
);
const second = await runOnce();
process.exit(second.code);
