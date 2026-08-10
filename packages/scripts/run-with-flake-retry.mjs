#!/usr/bin/env node
/**
 * Run a command once, and once more only when it fails with a known
 * infrastructure flake signature in its output. Exists for suites whose real
 * failures must stay loud while a named runner-level fault (e.g. Bun's
 * subprocess stdio wiring emitting `EEXIST … epoll_ctl` / `Failed to connect`
 * between tests) gets one bounded second chance. A failure that does not
 * match the signature is never retried.
 *
 * Signatures are matched incrementally as each stdout/stderr chunk arrives —
 * not just from a retained tail after the child exits. This prevents the
 * signature from being lost when a chatty suite emits more than the overlap
 * window of output after the flake line. Cross-chunk matching is preserved via
 * a bounded sliding overlap, so memory stays flat regardless of suite length.
 *
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

/** Bounded overlap window for cross-chunk regex matching (1 MiB). */
const OVERLAP_BYTES = 1048576;

/**
 * Incremental signature matcher: feeds every chunk through `signature.test`
 * against a sliding overlap so a match that straddles chunk boundaries is
 * still caught. Once matched, the flag stays set for the remainder of the run
 * — a signature is never forgotten once seen, even if subsequent output
 * pushes it out of the overlap window.
 */
function createSignatureTracker(signature) {
  let matched = false;
  let overlap = "";
  return {
    get matched() {
      return matched;
    },
    feed(chunk) {
      if (matched) return;
      const text = overlap + chunk.toString();
      if (signature.test(text)) {
        matched = true;
        overlap = "";
        return;
      }
      // Keep only the tail for cross-chunk boundary matching. Memory is bounded
      // regardless of total output volume.
      overlap = text.slice(-OVERLAP_BYTES);
    },
  };
}

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    const tracker = createSignatureTracker(signature);
    const capture = (chunk, sink) => {
      sink.write(chunk);
      tracker.feed(chunk);
    };
    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.on("error", (error) => {
      console.error(
        `[run-with-flake-retry] failed to start "${command}": ${error.message}`,
      );
      resolve({ code: 127, matched: tracker.matched });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), matched: tracker.matched });
    });
  });
}

const first = await runOnce();
if (first.code === 0 || first.code === 127 || !first.matched) {
  process.exit(first.code);
}
console.error(
  `[run-with-flake-retry] exit ${first.code} matched flake signature ${signature}; retrying once`,
);
const second = await runOnce();
process.exit(second.code);
