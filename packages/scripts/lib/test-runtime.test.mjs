/** Exercises runtime discovery and command forwarding with real temporary files and Node subprocesses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildTestRuntimeEnv, resolveExternalNode } from "./test-runtime.mjs";

test("discovers an executable using the manifest pin without an nvmrc", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-test-runtime-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: process.versions.node } }),
    );
    const executable = path.join(root, "node");
    symlinkSync(process.execPath, executable);
    const env = { PATH: root };
    assert.equal(resolveExternalNode({ repoRoot: root, env }), executable);
    assert.match(
      buildTestRuntimeEnv(env, { repoRoot: root }).NODE_OPTIONS,
      /--max-old-space-size=/,
    );
    writeFileSync(
      path.join(root, "package.json"),
      '{"engines":{"node":">=24"}}',
    );
    assert.throws(
      () => resolveExternalNode({ repoRoot: root, env }),
      /exact engines.node/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime wrapper resolves its repository outside the working directory and forwards exit status", () => {
  const wrapper = new URL("../with-test-runtime.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [wrapper.pathname, process.execPath, "-e", "process.exit(7)"],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 7, result.stderr);
});
