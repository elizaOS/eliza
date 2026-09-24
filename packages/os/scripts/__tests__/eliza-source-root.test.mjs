/** Exercises checkout selection for embedded and standalone OS builders using real directories. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveElizaSourceRoot } from "../eliza-source.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-source-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function app(root) {
  mkdirSync(path.join(root, "packages/app"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/app/package.json"),
    JSON.stringify({ name: "@elizaos/app" }),
  );
  return realpathSync(root);
}

test("embedded OS builders use the enclosing application checkout", (t) => {
  const root = app(fixture(t));
  assert.equal(
    resolveElizaSourceRoot({ osRoot: path.join(root, "packages/os"), env: {} }),
    root,
  );
});
test("standalone builders use their staged source checkout", (t) => {
  const osRoot = path.join(fixture(t), "standalone");
  const expected = app(path.join(osRoot, ".eliza-source"));
  assert.equal(resolveElizaSourceRoot({ osRoot, env: {} }), expected);
});
test("explicit checkout takes precedence and an invalid override never falls back", (t) => {
  const root = fixture(t);
  const workspace = app(path.join(root, "workspace"));
  const external = app(path.join(root, "external"));
  const osRoot = path.join(workspace, "packages/os");
  assert.equal(
    resolveElizaSourceRoot({ osRoot, env: { ELIZAOS_ELIZA_ROOT: external } }),
    external,
  );
  assert.throws(
    () =>
      resolveElizaSourceRoot({
        osRoot,
        env: { ELIZAOS_ELIZA_ROOT: path.join(root, "missing") },
      }),
    /Missing Eliza application/,
  );
  assert.throws(
    () => resolveElizaSourceRoot({ osRoot, env: { ELIZAOS_ELIZA_ROOT: "" } }),
    /non-empty checkout path/,
  );
});
