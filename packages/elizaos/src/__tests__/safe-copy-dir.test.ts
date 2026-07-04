/**
 * safe-copy-dir tests use real temporary directories to verify recursive copy
 * behavior, skip lists, and path-containment guards.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyDir } from "../../safe-copy-dir.ts";

describe("copyDir", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
  }

  it("copies regular files and directories", () => {
    const src = makeTempDir("elizaos-copy-src-");
    const dest = makeTempDir("elizaos-copy-dest-");
    fs.mkdirSync(path.join(src, "nested"));
    fs.writeFileSync(path.join(src, "nested", "hello.txt"), "hello");

    copyDir(src, dest);

    expect(
      fs.readFileSync(path.join(dest, "nested", "hello.txt"), "utf8"),
    ).toBe("hello");
  });

  it("refuses symbolic links to files (GHSA-jjf4-pjvf-h5jr)", () => {
    const src = makeTempDir("elizaos-copy-src-");
    const dest = makeTempDir("elizaos-copy-dest-");
    const secret = path.join(src, "secret.txt");
    fs.writeFileSync(secret, "leaked");
    fs.symlinkSync(secret, path.join(src, "leaked.txt"));

    expect(() => copyDir(src, dest)).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(dest, "leaked.txt"))).toBe(false);
  });

  it("refuses symbolic links to directories", () => {
    const src = makeTempDir("elizaos-copy-src-");
    const dest = makeTempDir("elizaos-copy-dest-");
    const realDir = path.join(src, "real");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "inside.txt"), "inside");
    fs.symlinkSync(realDir, path.join(src, "linked-dir"), "dir");

    expect(() => copyDir(src, dest)).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(dest, "linked-dir"))).toBe(false);
  });
});
