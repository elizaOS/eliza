import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  workspaceRuntimePackageDistDir,
  workspaceRuntimePackageLooksBuilt,
} from "./workspace-runtime-package.mjs";

function writeAt(filePath, milliseconds) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "fixture\n");
  const timestamp = new Date(milliseconds);
  fs.utimesSync(filePath, timestamp, timestamp);
}

test("plugin-sql uses its generated src/dist runtime tree", () => {
  assert.equal(
    workspaceRuntimePackageDistDir("@elizaos/plugin-sql", "/repo/plugin-sql"),
    path.join("/repo/plugin-sql", "src", "dist"),
  );
});

test("plugin-sql is rebuilt when current source is newer than ignored generated output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-sql-"));
  try {
    writeAt(path.join(root, "src", "dist", "node", "index.node.js"), 1_000);
    writeAt(path.join(root, "src", "dist", "index.node.d.ts"), 1_000);
    writeAt(path.join(root, "src", "services", "sql-principal.ts"), 2_000);

    assert.equal(
      workspaceRuntimePackageLooksBuilt("@elizaos/plugin-sql", root, {
        log() {},
      }),
      false,
    );

    writeAt(path.join(root, "src", "dist", "node", "index.node.js"), 3_000);
    writeAt(path.join(root, "src", "dist", "index.node.d.ts"), 3_000);
    assert.equal(
      workspaceRuntimePackageLooksBuilt("@elizaos/plugin-sql", root, {
        log() {},
      }),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin-sql without its Bun entrypoint is never reusable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-sql-"));
  try {
    writeAt(path.join(root, "src", "dist", "index.node.d.ts"), 2_000);
    writeAt(path.join(root, "src", "services", "sql-principal.ts"), 1_000);
    assert.equal(
      workspaceRuntimePackageLooksBuilt("@elizaos/plugin-sql", root),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
