/** Exercises runtime discovery and command forwarding with real temporary files and Node subprocesses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTestRuntimeEnv, resolveExternalNode } from "./test-runtime.ts";

test("discovers an executable using the manifest pin without an nvmrc", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-test-runtime-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: process.versions.node } }),
    );
    const env = { PATH: "", ELIZA_TEST_NODE: process.execPath };
    const options = {
      repoRoot: root,
      execPath: path.join(root, "embedded-node"),
    };
    assert.equal(resolveExternalNode({ ...options, env }), process.execPath);
    assert.match(
      buildTestRuntimeEnv(env, options).NODE_OPTIONS,
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
  const wrapper = new URL("../with-test-runtime.ts", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(wrapper), process.execPath, "-e", "process.exit(7)"],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 7, result.stderr);
});

test("preserves the caller's pinned Bun ahead of the home installation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-pinned-runtime-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: process.versions.node } }),
    );
    const callerToolchain = path.join(root, "pinned-tools");
    const env = buildTestRuntimeEnv(
      { PATH: callerToolchain },
      { repoRoot: root, execPath: process.execPath },
    );
    const entries = env.PATH.split(path.delimiter);
    assert.equal(entries[0], callerToolchain);
    const fallback = entries.indexOf(path.join(os.homedir(), ".bun", "bin"));
    assert.ok(fallback === -1 || fallback > entries.indexOf(callerToolchain));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
