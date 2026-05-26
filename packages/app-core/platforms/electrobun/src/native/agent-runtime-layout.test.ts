import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeEntryPath } from "./agent";

const tmpDirs: string[] = [];

function makeRuntimeDist(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milady-runtime-layout-"));
  tmpDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop runtime layout", () => {
  it("prefers root entry.js when both runtime layouts exist", () => {
    const root = makeRuntimeDist();
    const rootEntry = path.join(root, "entry.js");
    fs.writeFileSync(rootEntry, "");
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "runtime", "entry.js"), "");

    expect(resolveRuntimeEntryPath(root)).toBe(rootEntry);
  });

  it("accepts packaged runtime/entry.js layout", () => {
    const root = makeRuntimeDist();
    const runtimeEntry = path.join(root, "runtime", "entry.js");
    fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
    fs.writeFileSync(runtimeEntry, "");

    expect(resolveRuntimeEntryPath(root)).toBe(runtimeEntry);
  });
});
