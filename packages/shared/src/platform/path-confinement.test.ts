/**
 * Canonical path-confinement tests use the real filesystem to pin missing-tail
 * resolution, separator-aware containment, and fail-closed symlink errors.
 */

import fs, {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPathWithinRoot,
  resolveRealPath,
  resolveRealPathSync,
} from "./path-confinement.ts";

const cleanupPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { recursive: true, force: true });
  }
});

describe("realpath confinement", () => {
  it("canonicalizes a missing tail beneath an existing directory", async () => {
    const root = makeTempDir("eliza-realpath-root-");
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    const candidate = path.join(nested, "missing", "asset.js");
    const expected = path.join(realpathSync(nested), "missing", "asset.js");

    expect(resolveRealPathSync(candidate)).toBe(expected);
    await expect(resolveRealPath(candidate)).resolves.toBe(expected);
  });

  it("keeps root equality opt-in and accepts dot-prefixed child names", () => {
    const root = makeTempDir("eliza-realpath-equality-");
    expect(isPathWithinRoot(root, root)).toBe(false);
    expect(isPathWithinRoot(root, root, { allowRoot: true })).toBe(true);
    expect(isPathWithinRoot(path.join(root, "..safe.js"), root)).toBe(true);
    expect(isPathWithinRoot(path.join(root, "..", "outside.js"), root)).toBe(
      false,
    );
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink("fails closed on a dangling symlink", async () => {
    const root = makeTempDir("eliza-realpath-dangling-");
    const dangling = path.join(root, "dangling");
    symlinkSync("missing-target", dangling);

    expect(resolveRealPathSync(path.join(dangling, "asset.js"))).toBeNull();
    await expect(
      resolveRealPath(path.join(dangling, "asset.js")),
    ).resolves.toBeNull();
  });

  it("fails closed when canonicalization encounters a permission fault", async () => {
    const root = makeTempDir("eliza-realpath-permission-");
    const candidate = path.join(root, "asset.js");
    const permissionError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => {
      throw permissionError;
    });
    expect(resolveRealPathSync(candidate)).toBeNull();

    vi.spyOn(fs.promises, "realpath").mockRejectedValueOnce(permissionError);
    await expect(resolveRealPath(candidate)).resolves.toBeNull();
  });

  itSymlink("fails closed on a symlink loop", async () => {
    const root = makeTempDir("eliza-realpath-loop-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    symlinkSync("second", first);
    symlinkSync("first", second);

    expect(resolveRealPathSync(path.join(first, "asset.js"))).toBeNull();
    await expect(
      resolveRealPath(path.join(first, "asset.js")),
    ).resolves.toBeNull();
  });
});
