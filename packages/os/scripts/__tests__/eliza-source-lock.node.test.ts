import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultElizaSourceLockPath,
  readElizaSourceLock,
  validateElizaSourceLock,
} from "../read-eliza-source-lock.ts";
import {
  parseSourceLockUpdateArguments,
  updateElizaSourceLock,
} from "../update-eliza-source-lock.ts";

test("source-lock CLI uses the package lock and rejects ambiguous arguments", () => {
  assert.equal(
    parseSourceLockUpdateArguments([]).lockPath,
    defaultElizaSourceLockPath,
  );
  for (const argv of [
    ["--unknown", "x"],
    ["--commit"],
    ["--commit", "--lock"],
    ["--lock", "a", "--lock", "b"],
  ]) {
    assert.throws(
      () => parseSourceLockUpdateArguments(argv),
      /source-lock option/,
    );
  }
});

test("source lock rejects coerced strings and normalized invalid calendar dates", () => {
  const valid = readElizaSourceLock();
  for (const invalid of [
    { commit: [valid.commit] },
    { sourceRef: [valid.sourceRef] },
    { commitTimestamp: [valid.commitTimestamp] },
    { commitTimestamp: "2026-02-30T00:00:00Z" },
  ])
    assert.throws(() => validateElizaSourceLock({ ...valid, ...invalid }));
});

test("source-lock update preserves bytes on validation failure and publishes complete valid content", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "eliza-lock-update-"));
  const lockPath = path.join(directory, "lock.json");
  const original = readFileSync(defaultElizaSourceLockPath, "utf8");
  try {
    writeFileSync(lockPath, original);
    assert.throws(() =>
      updateElizaSourceLock({
        lockPath,
        commit: "a".repeat(40),
        commitTimestamp: "2026-02-30T00:00:00Z",
      }),
    );
    assert.equal(readFileSync(lockPath, "utf8"), original);
    assert.deepEqual(readdirSync(directory), ["lock.json"]);
    const updated = updateElizaSourceLock({
      lockPath,
      commit: "b".repeat(40),
      commitTimestamp: "2024-02-29T00:00:00Z",
    });
    assert.deepEqual(readElizaSourceLock(lockPath), updated);
    assert.equal(updated.commit, "b".repeat(40));
    assert.deepEqual(readdirSync(directory), ["lock.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shipped Eliza source lock is immutable and initializes submodules", () => {
  const lock = readElizaSourceLock(defaultElizaSourceLockPath);
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.repository, "elizaOS/eliza");
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.submodules, "recursive");
  assert.ok(Object.isFrozen(lock));
});

test("Eliza source lock rejects moving refs and partial SHAs", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "eliza-source-lock-test-"),
  );
  const lockPath = path.join(temporaryDirectory, "lock.json");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        repository: "elizaOS/eliza",
        sourceRef: "develop",
        commit: "develop",
        commitTimestamp: "2026-08-15T03:52:55Z",
        submodules: "recursive",
      }),
    );
    assert.throws(
      () => readElizaSourceLock(lockPath),
      /full lowercase Git SHA/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
