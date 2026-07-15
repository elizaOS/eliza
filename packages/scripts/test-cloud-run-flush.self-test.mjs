#!/usr/bin/env node

// Regression proof for the "Cloud Tests / unit-tests silently exits 1 with no
// surfaced failure" bug on PR #16062.
//
// Root cause: the batch runner (test-cloud-run.mjs) printed each `bun test`
// dump with `process.stdout.write` and then ended with `process.exit(1)`. When
// stdout is a back-pressured pipe (the GitHub Actions log collector), those
// writes queue in Node's internal stream buffer; the synchronous spawnSync loop
// never yields to drain them, and `process.exit()` tears the process down
// before the flush. The final batch's failure diagnostic AND earlier batches'
// summaries were discarded, so CI showed a bare `exited with code 1` with no
// failing test — a false "silent" failure that hid the real reason.
//
// Fix: write batch output straight to the fd via `fs.writeSync` (blocks until
// the bytes land, cannot be truncated by exit) and end with `process.exitCode`
// instead of `process.exit()`.
//
// This self-test reproduces the exact truncation mechanism: a child writes a
// large tail-marked payload then terminates, its stdout drained by a
// deliberately slow reader to force pipe back-pressure. The buggy pattern loses
// the tail; the fixed pattern preserves it. No repo build required.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const TAIL = "===DIAGNOSTIC-TAIL-MUST-SURVIVE===";
// Large enough to overflow the pipe + Node stream high-water mark so the write
// cannot complete synchronously under back-pressure.
const PAYLOAD_BYTES = 4 * 1024 * 1024;

const BUGGY_CHILD = `
const big = "x".repeat(${PAYLOAD_BYTES});
process.stdout.write(big);
process.stdout.write("${TAIL}\\n");
process.exit(1);
`;

const FIXED_CHILD = `
import { writeSync } from "node:fs";
function writeSyncAll(fd, text) {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error && error.code === "EAGAIN") continue;
      throw error;
    }
  }
}
const big = "x".repeat(${PAYLOAD_BYTES});
writeSyncAll(1, big);
writeSyncAll(1, "${TAIL}\\n");
process.exitCode = 1;
`;

// Drain the child's stdout slowly so the OS pipe buffer fills and the child's
// async writes back-pressure — the condition that makes process.exit() drop
// buffered output. A synchronous fd write is immune.
function runChild(source, { slowReader }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const chunks = [];
    let paused = false;
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      if (slowReader && !paused) {
        paused = true;
        child.stdout.pause();
        setTimeout(() => {
          paused = false;
          child.stdout.resume();
        }, 25);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

// 1. Reproduce the bug: buggy pattern under back-pressure drops the tail.
const buggy = await runChild(BUGGY_CHILD, { slowReader: true });
assert.equal(buggy.code, 1, "buggy child should still exit non-zero");
assert.ok(
  !buggy.output.includes(TAIL),
  "expected the buggy process.exit() pattern to truncate the diagnostic tail " +
    "under pipe back-pressure (the #16062 silent-exit repro); if this ever " +
    "passes the tail through, the repro is no longer valid on this Node.",
);

// 2. Prove the fix: synchronous writes + exitCode preserve the tail AND the code.
const fixed = await runChild(FIXED_CHILD, { slowReader: true });
assert.equal(fixed.code, 1, "fixed child must still exit non-zero");
assert.ok(
  fixed.output.includes(TAIL),
  "fixed writeSync + process.exitCode pattern must preserve the diagnostic tail",
);
assert.equal(
  fixed.output.length,
  PAYLOAD_BYTES + TAIL.length + 1,
  "fixed pattern must emit the full payload with no truncation",
);

console.log("[test-cloud-run-flush] self-test passed");
