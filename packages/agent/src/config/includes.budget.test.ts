/**
 * Real-filesystem coverage for bounded config includes and shared graph budgets.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigIncludeError, resolveConfigIncludes } from "./includes.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-includes-"));
  roots.push(root);
  return root;
}

describe("resolveConfigIncludes byte budgets", () => {
  it("loads an honest include through the production filesystem resolver", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "child.json5"), "{ enabled: true }");
    expect(
      resolveConfigIncludes(
        { $include: "./child.json5" },
        path.join(root, "root.json5"),
      ),
    ).toEqual({ enabled: true });
  });

  it("rejects an oversized regular file before reading its contents", () => {
    const root = tempRoot();
    const child = path.join(root, "child.json5");
    const handle = fs.openSync(child, "w");
    fs.ftruncateSync(handle, 1_048_577);
    fs.closeSync(handle);
    expect(() =>
      resolveConfigIncludes(
        { $include: "./child.json5" },
        path.join(root, "root.json5"),
      ),
    ).toThrow(ConfigIncludeError);
  });

  it("shares an aggregate budget across sibling include processors", () => {
    const raw = JSON.stringify({ payload: "x".repeat(40_000) });
    const files = new Map<string, string>();
    for (let i = 0; i < 220; i += 1)
      files.set(path.normalize(`/cfg/${i}.json5`), raw);
    expect(() =>
      resolveConfigIncludes(
        { $include: Array.from({ length: 220 }, (_, i) => `./${i}.json5`) },
        "/cfg/root.json5",
        { readFile: (file) => files.get(file) ?? "{}", parseJson: JSON.parse },
      ),
    ).toThrow(/Include graph exceeds/);
  });
});
