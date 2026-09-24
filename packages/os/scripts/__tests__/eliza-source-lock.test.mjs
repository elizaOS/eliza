import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultElizaSourceLockPath,
  readElizaSourceLock,
} from "../read-eliza-source-lock.mjs";

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
