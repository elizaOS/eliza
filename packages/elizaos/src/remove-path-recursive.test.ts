/**
 * Recursive removal tests use real temporary directories to verify retry-safe
 * cleanup of nested files and missing paths.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removePathRecursive } from "./remove-path-recursive.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "elizaos-rm-recursive-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("removePathRecursive", () => {
  it("removes nested directories", async () => {
    const root = makeTempDir();
    const target = path.join(root, "nested", "tree");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "marker.txt"), "ok");

    await removePathRecursive(path.join(root, "nested"));

    expect(existsSync(path.join(root, "nested"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("ignores missing paths", async () => {
    const root = makeTempDir();

    await expect(
      removePathRecursive(path.join(root, "missing")),
    ).resolves.toBeUndefined();
  });

  it("rejects an empty path argument", async () => {
    await expect(removePathRecursive("")).rejects.toThrow(
      /empty path argument/,
    );
  });

  it("rejects filesystem roots", async () => {
    await expect(
      removePathRecursive(path.parse(process.cwd()).root),
    ).rejects.toThrow(/filesystem root/);
  });
});
