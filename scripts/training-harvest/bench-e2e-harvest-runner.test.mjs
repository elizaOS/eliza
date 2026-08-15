/**
 * Deterministic parser and real child-process CLI boundary tests for the E2E
 * training-harvest runner. Invalid CLI input fails before provider or network
 * access.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseHarvestLimit,
  parseHarvestShard,
  parseItemTimeoutMs,
} from "./bench-e2e-harvest-runner.mjs";

const runner = fileURLToPath(
  new URL("./bench-e2e-harvest-runner.mjs", import.meta.url),
);
const maxSafe = String(Number.MAX_SAFE_INTEGER);
const overflow = `${maxSafe}0`;
const invalidDecimalIntegers = [
  "",
  " ",
  " 12",
  "12 ",
  "-1",
  "+1",
  "1.5",
  "1e2",
  "12junk",
  "Infinity",
  overflow,
];

test("parseHarvestLimit accepts the unlimited sentinel and safe bounds", () => {
  assert.equal(parseHarvestLimit("0"), 0);
  assert.equal(parseHarvestLimit("12"), 12);
  assert.equal(parseHarvestLimit("00012"), 12);
  assert.equal(parseHarvestLimit(maxSafe), Number.MAX_SAFE_INTEGER);
});

test("parseHarvestLimit rejects non-decimal and unsafe values", () => {
  for (const raw of invalidDecimalIntegers) {
    assert.throws(() => parseHarvestLimit(raw), /--limit.*got/);
  }
});

test("parseItemTimeoutMs accepts positive safe decimal integers", () => {
  assert.equal(parseItemTimeoutMs("1"), 1);
  assert.equal(parseItemTimeoutMs("12"), 12);
  assert.equal(parseItemTimeoutMs("00012"), 12);
  assert.equal(parseItemTimeoutMs(maxSafe), Number.MAX_SAFE_INTEGER);
});

test("parseItemTimeoutMs rejects zero, non-decimal, and unsafe values", () => {
  for (const raw of ["0", "000", ...invalidDecimalIntegers]) {
    assert.throws(() => parseItemTimeoutMs(raw), /--item-timeout-ms.*got/);
  }
});

test("parseHarvestShard accepts valid shard coordinates and safe bounds", () => {
  assert.deepEqual(parseHarvestShard("0/1"), [0, 1]);
  assert.deepEqual(parseHarvestShard("1/2"), [1, 2]);
  assert.deepEqual(parseHarvestShard("01/02"), [1, 2]);
  assert.deepEqual(parseHarvestShard(`0/${maxSafe}`), [
    0,
    Number.MAX_SAFE_INTEGER,
  ]);
});

test("parseHarvestShard rejects malformed, unsafe, and out-of-range shards", () => {
  for (const raw of [
    "",
    " ",
    " 1/2",
    "1/2 ",
    "+1/2",
    "1.0/2",
    "1e0/2",
    "1junk/2",
    "Infinity/2",
    `0/${overflow}`,
    "1/0",
    "5/2",
    "-1/2",
    "1/2/3",
    "a/b",
  ]) {
    assert.throws(() => parseHarvestShard(raw), /--shard.*got/);
  }
});

test("invalid CLI input fails before deterministic planning", () => {
  const result = spawnSync(
    process.execPath,
    [runner, "--dry-run", "--deterministic", "--item-timeout-ms", "1e2"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--item-timeout-ms/);
  assert.doesNotMatch(result.stdout, /would harvest|summary/);
});

test("import ignores poisoned ambient argv and does not run main", async () => {
  const originalArgv = [...process.argv];
  process.argv.splice(1, process.argv.length - 1, "--limit", "not-a-number");
  try {
    const imported = await import(
      `${pathToFileURL(runner).href}?ambient-argv=${Date.now()}`
    );
    assert.equal(typeof imported.parseRunnerConfig, "function");
  } finally {
    process.argv.splice(0, process.argv.length, ...originalArgv);
  }
});

test("direct execution works through a symlink in a spaced path", (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "eliza harvest "));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const linkedRunner = path.join(tempDir, "runner link.mjs");
  symlinkSync(runner, linkedRunner);
  assert.equal(realpathSync(linkedRunner), realpathSync(runner));

  const result = spawnSync(
    process.execPath,
    [linkedRunner, "--limit", "not-a-number"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /--limit must be a decimal integer \(got "not-a-number"\)/,
  );
  assert.doesNotMatch(result.stdout, /would harvest|summary/);
});
