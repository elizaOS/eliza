/** Exercises checkout selection for embedded and standalone OS builders using real directories. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveElizaSourceRoot } from "../eliza-source.ts";

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

test("AOSP smoke loads configuration code from the selected application checkout", (t) => {
  const root = app(fixture(t));
  const library = path.join(root, "packages/app/scripts/aosp/lib");
  mkdirSync(library, { recursive: true });
  writeFileSync(
    path.join(library, "load-variant-config.ts"),
    'export function resolveAppConfigPath() { throw new Error("selected checkout loader reached"); }\nexport function loadAospVariantConfig() {}\n',
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../aosp/smoke-cuttlefish.ts", import.meta.url))],
    {
      env: { ...process.env, ELIZAOS_ELIZA_ROOT: root },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selected checkout loader reached/);
});

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

test("symlinked resolver CLI selects explicit source and reports invalid overrides", (t) => {
  const root = fixture(t);
  const external = app(path.join(root, "external checkout"));
  const linked = path.join(root, "resolve.mjs");
  symlinkSync(
    fileURLToPath(new URL("../eliza-source.ts", import.meta.url)),
    linked,
  );
  const run = (checkout) =>
    spawnSync(process.execPath, [linked], {
      cwd: root,
      env: { ...process.env, ELIZAOS_ELIZA_ROOT: checkout },
      encoding: "utf8",
      timeout: 5000,
    });
  const success = run(external);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${external}\n`);
  const failure = run(path.join(root, "missing checkout"));
  assert.equal(failure.status, 1, failure.stderr);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /Missing Eliza application/);
});
