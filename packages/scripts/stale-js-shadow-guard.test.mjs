/** Exercises the stale JavaScript guard against isolated, real Git repositories on disk. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { findStaleJsShadows, run } from "./stale-js-shadow-guard.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eliza-stale-js-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "*.js\n");
  mkdirSync(join(root, "packages/ui/src"), { recursive: true });
  mkdirSync(join(root, "packages/core/src"), { recursive: true });
  return root;
}

test("finds only ignored JavaScript files that shadow TypeScript under src", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, "packages/ui/src/button.tsx"), "export {};\n");
  writeFileSync(join(root, "packages/ui/src/button.js"), "stale\n");
  writeFileSync(join(root, "packages/core/src/runtime.ts"), "export {};\n");
  writeFileSync(join(root, "packages/core/src/runtime.js"), "stale\n");
  writeFileSync(join(root, "packages/ui/src/generated.js"), "valid\n");
  writeFileSync(join(root, "outside.ts"), "export {};\n");
  writeFileSync(join(root, "outside.js"), "ignored but outside src\n");

  assert.deepEqual(findStaleJsShadows(root), [
    "packages/core/src/runtime.js",
    "packages/ui/src/button.js",
  ]);
});

test("clean mode removes every detected shadow and preserves unrelated JavaScript", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const shadow = join(root, "packages/ui/src/button.js");
  const unrelated = join(root, "packages/ui/src/generated.js");
  writeFileSync(join(root, "packages/ui/src/button.ts"), "export {};\n");
  writeFileSync(shadow, "stale\n");
  writeFileSync(unrelated, "valid\n");

  assert.equal(run({ root, clean: true }), 0);
  assert.throws(() => readFileSync(shadow));
  assert.equal(readFileSync(unrelated, "utf8"), "valid\n");
  assert.deepEqual(findStaleJsShadows(root), []);
});

test("allows source archives that do not contain Git metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "eliza-source-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(run({ root }), 0);
});
