/**
 * Unit tests for the GPU vision service's pure logic: lockfile reconciliation
 * (the fail-loud integrity gate), the llama.cpp version-gate boundary, port and
 * arg parsing, the torn-download size floor, the setup skip-path wiring (a
 * present-but-wrong blob must still fail the sha256 gate), and the readiness
 * poller against a real in-process HTTP stub. The download, process launch, and
 * OCR request are exercised by the real smoke run, not here.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertLlamaBuildSupported,
  assertPlausibleSize,
  formatBytes,
  lockKey,
  MODEL_SETS,
  modelFilePath,
  parseArgs,
  parseLlamaBuild,
  parsePort,
  parsePositiveInteger,
  reconcileLock,
  sha256File,
  waitForReady,
} from "./lib.mjs";
import { ensureFile } from "./setup.mjs";

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

test("version gate boundary: b8524 rejected, b8525 accepted, garbage throws", () => {
  assert.throws(
    () => assertLlamaBuildSupported("version: 8524 (deadbeef)"),
    /too old for DeepSeek-OCR/,
  );
  assert.equal(assertLlamaBuildSupported("version: 8525 (deadbeef)"), 8525);
  assert.equal(assertLlamaBuildSupported("version: 9870 (2d973636e)"), 9870);
  assert.throws(
    () => assertLlamaBuildSupported("not a version banner"),
    /could not parse/,
  );
});

test("parsePort validates flag and env port values", () => {
  assert.equal(parsePort(undefined, "X"), undefined);
  assert.equal(parsePort("", "X"), undefined);
  assert.equal(parsePort("  ", "X"), undefined);
  assert.equal(parsePort("8080", "X"), 8080);
  assert.equal(parsePort(8080, "X"), 8080);
  assert.throws(() => parsePort("not-a-port", "X"), /integer port/);
  assert.throws(() => parsePort("0", "X"), /integer port/);
  assert.throws(() => parsePort("70000", "X"), /integer port/);
  assert.throws(() => parsePort("80.5", "X"), /integer port/);
  // A bare `--port` flag parses to boolean true — a usage error, never port 1.
  assert.throws(() => parsePort(true, "X"), /requires a port number/);
});

test("parsePositiveInteger rejects bare value flags instead of coercing them", () => {
  assert.equal(parsePositiveInteger(undefined, "--parallel", 2), 2);
  assert.equal(parsePositiveInteger("", "--parallel", 2), 2);
  assert.equal(parsePositiveInteger("4", "--parallel", 2), 4);
  assert.equal(parsePositiveInteger(4, "--parallel", 2), 4);
  assert.throws(
    () => parsePositiveInteger(true, "--parallel", 2),
    /requires a positive integer/,
  );
  assert.throws(
    () => parsePositiveInteger("0", "--parallel", 2),
    /positive integer/,
  );
  assert.throws(
    () => parsePositiveInteger("1.5", "--parallel", 2),
    /positive integer/,
  );
});

test("assertPlausibleSize accepts near-pinned sizes and rejects torn downloads", () => {
  assert.doesNotThrow(() => assertPlausibleSize(1000, 1000, "f"));
  assert.doesNotThrow(() => assertPlausibleSize(960, 1000, "f"));
  assert.throws(() => assertPlausibleSize(500, 1000, "f"), /truncated/);
  assert.throws(() => assertPlausibleSize(2000, 1000, "f"), /truncated/);
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

test("ensureFile skip-if-present path still enforces the lockfile sha256 gate", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gpu-vision-test-"));
  const prevCache = process.env.ELIZA_GPU_VISION_CACHE;
  process.env.ELIZA_GPU_VISION_CACHE = tmp;
  t.after(async () => {
    if (prevCache === undefined) delete process.env.ELIZA_GPU_VISION_CACHE;
    else process.env.ELIZA_GPU_VISION_CACHE = prevCache;
    await rm(tmp, { recursive: true, force: true });
  });

  const destPath = modelFilePath("ocr", "model");
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, "definitely not the pinned model bytes");
  const actualSha = await sha256File(destPath);
  const key = lockKey("ocr", "model");

  // Present file whose hash contradicts the pin must fail loud — the skip
  // path re-hashing is what makes "already downloaded" trustworthy.
  await assert.rejects(
    ensureFile({
      setKey: "ocr",
      role: "model",
      hfBin: null,
      lock: { [key]: { sha256: "0".repeat(64) } },
    }),
    /sha256 mismatch/,
  );

  // Present file matching the pin is skipped without a download.
  const result = await ensureFile({
    setKey: "ocr",
    role: "model",
    hfBin: null,
    lock: { [key]: { sha256: actualSha } },
  });
  assert.equal(result.downloaded, false);
});

test("waitForReady resolves once the stub returns 200", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
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

test("waitForReady aborts a probe that accepts but never responds", async () => {
  // A server that accepts the TCP connection and then goes silent must not
  // hang the poller — the per-probe abort converts it into a poll failure.
  const server = http.createServer(() => {
    // never respond; the probe's AbortSignal is what ends this request
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await assert.rejects(
      waitForReady(`http://127.0.0.1:${port}/health`, {
        timeoutMs: 400,
        intervalMs: 50,
        probeTimeoutMs: 100,
      }),
      /server not ready/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
