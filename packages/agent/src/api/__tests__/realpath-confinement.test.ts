/**
 * Exercises canonical path confinement against a real temporary filesystem:
 * missing-tail resolution, dangling links, symlink loops, and containment
 * checks. No mocks — every case resolves through actual `node:fs` entries.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPathWithinRoot,
  resolveRealPath,
  resolveRealPathSync,
} from "../realpath-confinement.ts";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "realpath-confinement-"));
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

function existingRoot(): string {
  return fs.realpathSync(root);
}

describe("resolveRealPathSync", () => {
  it("returns the canonical spelling of an existing file", () => {
    const dir = path.join(root, "dir");
    fs.mkdirSync(dir);
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");

    const resolved = resolveRealPathSync(file);

    expect(resolved).toBe(path.join(existingRoot(), "dir", "file.txt"));
  });

  it("resolves a missing tail through its deepest existing ancestor", () => {
    fs.mkdirSync(path.join(root, "a"));

    const resolved = resolveRealPathSync(
      path.join(root, "a", "missing", "file.txt"),
    );

    expect(resolved).toBe(
      path.join(existingRoot(), "a", "missing", "file.txt"),
    );
  });

  it("resolves a multi-level missing tail in order", () => {
    const resolved = resolveRealPathSync(
      path.join(root, "one", "two", "three.txt"),
    );

    expect(resolved).toBe(path.join(existingRoot(), "one", "two", "three.txt"));
  });

  it("fails closed on a dangling symlink", () => {
    const link = path.join(root, "dangling");
    fs.symlinkSync(path.join(root, "gone"), link);

    expect(resolveRealPathSync(link)).toBeNull();
  });

  it("fails closed when the walk reaches a dangling ancestor", () => {
    fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "link"));

    expect(
      resolveRealPathSync(path.join(root, "link", "child.txt")),
    ).toBeNull();
  });

  it("fails closed on a symlink loop instead of throwing", () => {
    fs.symlinkSync("loop", path.join(root, "loop"));

    expect(resolveRealPathSync(path.join(root, "loop"))).toBeNull();
  });
});

describe("resolveRealPath", () => {
  it("canonicalizes an existing file asynchronously", async () => {
    fs.mkdirSync(path.join(root, "async-dir"));
    const file = path.join(root, "async-dir", "file.txt");
    fs.writeFileSync(file, "x");

    await expect(resolveRealPath(file)).resolves.toBe(
      path.join(existingRoot(), "async-dir", "file.txt"),
    );
  });

  it("joins a missing tail onto the async ancestor realpath", async () => {
    fs.mkdirSync(path.join(root, "present"));

    await expect(
      resolveRealPath(path.join(root, "present", "later.txt")),
    ).resolves.toBe(path.join(existingRoot(), "present", "later.txt"));
  });

  it("rejects a dangling symlink with null asynchronously", async () => {
    fs.symlinkSync(
      path.join(root, "vanished"),
      path.join(root, "async-dangling"),
    );

    await expect(
      resolveRealPath(path.join(root, "async-dangling")),
    ).resolves.toBeNull();
  });
});

describe("isPathWithinRoot", () => {
  it("accepts a nested candidate", () => {
    expect(isPathWithinRoot(`${root}/nested/file.txt`, root)).toBe(true);
  });

  it("accepts a deeply nested candidate", () => {
    expect(isPathWithinRoot(`${root}/a/b/c/d.txt`, root)).toBe(true);
  });

  it("rejects the root itself by default and accepts with allowRoot", () => {
    expect(isPathWithinRoot(root, root)).toBe(false);
    expect(isPathWithinRoot(root, root, { allowRoot: true })).toBe(true);
  });

  it("rejects a sibling path that shares a prefix without a separator", () => {
    expect(isPathWithinRoot(`${root}-evil/file.txt`, root)).toBe(false);
  });

  it("rejects an escape through a parent segment", () => {
    expect(isPathWithinRoot(`${root}/../escaped.txt`, root)).toBe(false);
  });

  it("rejects a completely unrelated absolute path", () => {
    expect(isPathWithinRoot("/opt/unrelated/file.txt", root)).toBe(false);
  });
});
