import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  advancePublisherPolicy,
  initializePublisherPolicy,
  readPublisherPolicy,
} from "../publisher-policy.mjs";

const roles = ["root", "timestamp", "snapshot", "targets", "stable", "beta"],
  versions = (n) => Object.fromEntries(roles.map((role) => [role, n]));
function scenario(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-policy-")),
    file = path.join(dir, "policy.db");
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("publisher floors require explicit provisioning and cannot reset an existing policy", () =>
  scenario((file) => {
    assert.throws(() => readPublisherPolicy(file, 1));
    assert.equal(fs.existsSync(file), false);
    initializePublisherPolicy(file, versions(1));
    advancePublisherPolicy(file, versions(2));
    assert.throws(() => initializePublisherPolicy(file, versions(1)), /EEXIST/);
    assert.deepEqual(readPublisherPolicy(file, 123), {
      trustedUpperMs: 123,
      minimumVersions: versions(2),
    });
  }));
test("partial, unsafe and extra role policies and unqualified time are rejected", () =>
  scenario((file) => {
    for (const value of [
      { root: 1 },
      { ...versions(1), extra: 1 },
      { ...versions(1), beta: 0 },
      { ...versions(1), stable: 2 ** 53 },
    ])
      assert.throws(
        () => initializePublisherPolicy(file, value),
        /complete safe/,
      );
    initializePublisherPolicy(file, versions(1));
    for (const time of [NaN, Infinity, 0, -1, 1.5, 2 ** 53])
      assert.throws(() => readPublisherPolicy(file, time), /qualified time/);
  }));
test("stale concurrent authorization cannot lower any role or partly advance others", () =>
  scenario((file) => {
    initializePublisherPolicy(file, versions(1));
    const stale = readPublisherPolicy(file, 1).minimumVersions;
    advancePublisherPolicy(file, { ...stale, beta: 3 });
    assert.throws(
      () => advancePublisherPolicy(file, { ...stale, stable: 4 }),
      /rollback/,
    );
    assert.deepEqual(readPublisherPolicy(file, 1).minimumVersions, {
      ...stale,
      beta: 3,
    });
    advancePublisherPolicy(file, { ...stale, beta: 3 });
  }));
test("missing roles and unsupported schema fail closed without reset", () => {
  for (const sql of [
    "DELETE FROM floors WHERE role='beta'",
    "PRAGMA user_version=2",
  ])
    scenario((file) => {
      initializePublisherPolicy(file, versions(1));
      const db = new DatabaseSync(file);
      db.exec(sql);
      db.close();
      assert.throws(() => readPublisherPolicy(file, 1));
      assert.throws(() => advancePublisherPolicy(file, versions(2)));
    });
});
test("policy survives writer death after commit and rolls back death during a transaction", () => {
  for (const committed of [true, false])
    scenario((file) => {
      initializePublisherPolicy(file, versions(1));
      const moduleURL = new URL("../publisher-policy.mjs", import.meta.url)
        .href;
      const code = committed
        ? `import {advancePublisherPolicy} from ${JSON.stringify(moduleURL)};advancePublisherPolicy(process.argv[1],JSON.parse(process.argv[2]));process.kill(process.pid,'SIGKILL');`
        : `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA synchronous=FULL;BEGIN IMMEDIATE;UPDATE floors SET version=2 WHERE role IN ('stable','beta')");process.kill(process.pid,'SIGKILL');`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", code, file, JSON.stringify(versions(2))],
        { timeout: 30000, encoding: "utf8" },
      );
      assert.equal(result.signal, "SIGKILL", result.stderr);
      assert.deepEqual(
        readPublisherPolicy(file, 1).minimumVersions,
        versions(committed ? 2 : 1),
      );
    });
});
