import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importMeasuredPackage } from "./target-package.ts";

test("selected workspace export wins over a hoisted package and rejects escaped exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-target-"));
  const outside = mkdtempSync(join(tmpdir(), "benchmark-other-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const owner = join(root, "packages", "sample");
    mkdirSync(owner, { recursive: true });
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({
        name: "sample",
        type: "module",
        exports: { ".": "./index.mjs", "./escaped": "./escaped.mjs" },
      }),
    );
    writeFileSync(
      join(owner, "index.mjs"),
      "export const revision = 'selected';",
    );
    const hoisted = join(root, "node_modules", "sample");
    mkdirSync(hoisted, { recursive: true });
    writeFileSync(
      join(hoisted, "package.json"),
      JSON.stringify({
        name: "sample",
        type: "module",
        exports: "./index.mjs",
      }),
    );
    writeFileSync(
      join(hoisted, "index.mjs"),
      "export const revision = 'wrong';",
    );
    writeFileSync(
      join(outside, "index.mjs"),
      "export const revision = 'escaped';",
    );
    symlinkSync(join(outside, "index.mjs"), join(owner, "escaped.mjs"));
    assert.equal(
      (await importMeasuredPackage(root, "sample")).revision,
      "selected",
    );
    await assert.rejects(
      importMeasuredPackage(root, "sample/escaped"),
      /outside/,
    );
    await assert.rejects(
      importMeasuredPackage(root, "missing"),
      /No workspace package/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
