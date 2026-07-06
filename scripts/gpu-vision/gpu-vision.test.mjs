/**
 * Unit tests for the GPU vision service's pure logic: lockfile reconciliation
 * (the fail-loud integrity gate), version parsing, arg parsing, and the readiness
 * poller against a real in-process HTTP stub. These cover the pieces that must be
 * correct before a real download or server launch is trusted; the download,
 * process launch, and OCR request are exercised by the real smoke run, not here.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  formatBytes,
  lockKey,
  MIN_LLAMA_BUILD,
  MODEL_SETS,
  parseArgs,
  parseLlamaBuild,
  reconcileLock,
  waitForReady,
} from "./lib.mjs";

test("model sets pin exact repo, revision, and filenames", () => {
  assert.equal(MODEL_SETS.ocr.repo, "sahilchachra/Unlimited-OCR-GGUF");
  assert.equal(MODEL_SETS.ocr.files.model.name, "Unlimited-OCR-Q4_K_M.gguf");
  assert.equal(
    MODEL_SETS.ocr.files.mmproj.name,
    "mmproj-Unlimited-OCR-F16.gguf",
  );
  assert.match(MODEL_SETS.ocr.revision, /^[0-9a-f]{40}$/);
  assert.equal(MODEL_SETS.vlm.repo, "Qwen/Qwen3-VL-4B-Instruct-GGUF");
  assert.match(MODEL_SETS.vlm.revision, /^[0-9a-f]{40}$/);
});

test("lockKey encodes repo, revision, and file", () => {
  assert.equal(
    lockKey("ocr", "model"),
    "sahilchachra/Unlimited-OCR-GGUF@0dc781d8a23f52963918ebd5b2d1b9fe61504661/Unlimited-OCR-Q4_K_M.gguf",
  );
});

test("reconcileLock records a new pin when none exists", () => {
  const lock = {};
  const result = reconcileLock(lock, "k", { sha256: "abc" });
  assert.equal(result.status, "recorded");
  assert.equal(result.entry.sha256, "abc");
});

test("reconcileLock verifies a matching pin", () => {
  const lock = { k: { sha256: "abc" } };
  const result = reconcileLock(lock, "k", { sha256: "abc" });
  assert.equal(result.status, "verified");
});

test("reconcileLock throws loud on sha256 mismatch", () => {
  const lock = { k: { sha256: "expected" } };
  assert.throws(
    () => reconcileLock(lock, "k", { sha256: "different" }),
    /sha256 mismatch/,
  );
});

test("parseLlamaBuild extracts the build integer", () => {
  assert.equal(
    parseLlamaBuild("version: 9870 (2d973636e)\nbuilt with ..."),
    9870,
  );
  assert.equal(parseLlamaBuild("version: 8525 (abc)"), 8525);
  assert.equal(parseLlamaBuild("no version here"), null);
});

test("MIN_LLAMA_BUILD is the DeepSeek-OCR floor", () => {
  // b8525 is the first release containing PR 17400 (merged 2026-03-25).
  assert.equal(MIN_LLAMA_BUILD, 8525);
});

test("parseArgs handles flags, key=value, key value, and positionals", () => {
  const { flags, positionals } = parseArgs(
    ["--with-vlm", "--parallel", "4", "--port=9999", "fixture.png"],
    { booleans: ["with-vlm"] },
  );
  assert.equal(flags["with-vlm"], true);
  assert.equal(flags.parallel, "4");
  assert.equal(flags.port, "9999");
  assert.deepEqual(positionals, ["fixture.png"]);
});

test("parseArgs treats a bare boolean flag before a value flag correctly", () => {
  const { flags } = parseArgs(["--stop", "--vlm"], {
    booleans: ["stop", "vlm"],
  });
  assert.equal(flags.stop, true);
  assert.equal(flags.vlm, true);
});

test("formatBytes renders GiB and MiB", () => {
  assert.equal(formatBytes(2 * 1024 ** 3), "2.00 GiB");
  assert.equal(formatBytes(512 * 1024 ** 2), "512.0 MiB");
  assert.equal(formatBytes(Number.NaN), "unknown");
});

test("waitForReady resolves once the stub returns 200", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    // Fail the first probe, succeed the second — exercises the poll loop.
    res.statusCode = hits >= 2 ? 200 : 503;
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const ready = await waitForReady(`http://127.0.0.1:${port}/health`, {
      timeoutMs: 5000,
      intervalMs: 20,
    });
    assert.equal(ready, true);
    assert.ok(hits >= 2);
  } finally {
    server.close();
  }
});

test("waitForReady throws on timeout with the last error", async () => {
  // Nothing listening on this port; the poller must give up loud, not hang.
  await assert.rejects(
    waitForReady("http://127.0.0.1:1/health", {
      timeoutMs: 200,
      intervalMs: 50,
    }),
    /server not ready/,
  );
});
