import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConsumerSourceError,
  inspectDevelopmentRuntime,
} from "./committed-source.mjs";

test("source provenance fences wrong commits, tracked and untracked modifications before runtime use", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "development-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(root, "packages/agent/src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages/agent/src/bin.ts"),
    "// inert fixture",
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD"),
    options = {
      source: root,
      runtimeBinary: process.execPath,
      expectedCommit: commit,
    };
  const admitted = inspectDevelopmentRuntime(options);
  assert.equal(admitted.sourceCommit, commit);
  assert.equal(admitted.dirty, false);
  assert.match(admitted.bunVersion, /^v\d+/);
  assert.throws(
    () =>
      inspectDevelopmentRuntime({ ...options, expectedCommit: "a".repeat(40) }),
    ConsumerSourceError,
  );
  fs.writeFileSync(path.join(root, "untracked.ts"), "// fixture");
  assert.throws(() => inspectDevelopmentRuntime(options), /modifications/);
  assert.equal(
    inspectDevelopmentRuntime({ ...options, expectedCommit: undefined }).dirty,
    true,
  );
  fs.unlinkSync(path.join(root, "untracked.ts"));
  fs.appendFileSync(path.join(root, "packages/agent/src/bin.ts"), " changed");
  assert.throws(() => inspectDevelopmentRuntime(options), /modifications/);
  for (const source of ["relative", path.join(root, "missing")])
    assert.throws(
      () => inspectDevelopmentRuntime({ ...options, source }),
      ConsumerSourceError,
    );
});
