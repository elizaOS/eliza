/**
 * Cross-platform verification contracts for source discovery, generated i18n
 * execution, and native-package lint orchestration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { discoverTypeScriptFiles } from "../run-biome-typescript.mjs";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-contracts "));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TypeScript-only Biome discovery", () => {
  test("is recursive, deterministic, and excludes declarations and fixtures", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "z.ts"), "");
    fs.writeFileSync(path.join(root, "nested", "a.ts"), "");
    fs.writeFileSync(path.join(root, "types.d.ts"), "");
    fs.writeFileSync(path.join(root, "component.tsx"), "");
    fs.writeFileSync(path.join(root, "fixture.json"), "{}");

    expect(
      discoverTypeScriptFiles(root).map((file) => path.relative(root, file)),
    ).toEqual([path.join("nested", "a.ts"), "z.ts"]);
  });
});
