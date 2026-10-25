/**
 * Real-fs tests for browser-workspace command path confinement.
 *
 * Origin `writeBrowserWorkspaceFile` resolved + mkdir recursive with no root,
 * so screenshot/state/pdf/baseline paths wrote through symlink parents and
 * absolute paths outside cwd. These tests use a real temp root, not mocks.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBrowserWorkspaceError } from "../browser-workspace-errors.ts";
import {
  resolveBrowserWorkspaceFilePath,
  writeBrowserWorkspaceFile,
} from "../browser-workspace-helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bw-file-path-"));
  roots.push(dir);
  return fs.realpathSync(dir);
}

describe("resolveBrowserWorkspaceFilePath", () => {
  it("accepts a descendant of the workspace root", async () => {
    const root = await makeRoot();
    const inside = path.join(root, "nested", "ok.txt");
    expect(resolveBrowserWorkspaceFilePath(inside, root)).toBe(inside);
  });

  it("accepts a sibling named ..safe.js (not a traversal)", async () => {
    const root = await makeRoot();
    const sibling = path.join(root, "..safe.js");
    expect(resolveBrowserWorkspaceFilePath(sibling, root)).toBe(sibling);
  });

  it("rejects lexical .. that leaves the root", async () => {
    const root = await makeRoot();
    expect(() =>
      resolveBrowserWorkspaceFilePath(
        path.join(root, "..", "outside.txt"),
        root,
      ),
    ).toThrow(/escapes the workspace root/);
  });

  it("rejects an absolute path outside the root", async () => {
    const root = await makeRoot();
    expect(() => resolveBrowserWorkspaceFilePath("/etc/passwd", root)).toThrow(
      /escapes the workspace root/,
    );
  });

  it("rejects empty, NUL, and UNC paths", () => {
    expect(() => resolveBrowserWorkspaceFilePath("  ")).toThrow(
      /empty file path/,
    );
    expect(() => resolveBrowserWorkspaceFilePath("foo\0bar")).toThrow(/NUL/);
    expect(() => resolveBrowserWorkspaceFilePath("//server/share")).toThrow(
      /UNC/,
    );
  });

  it("rejects a path whose parent is a symlink out of the root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fsp.symlink(outside, path.join(root, "link"));
    expect(() =>
      resolveBrowserWorkspaceFilePath(
        path.join(root, "link", "pwned.txt"),
        root,
      ),
    ).toThrow(/escapes the workspace root/);
  });
});

describe("writeBrowserWorkspaceFile", () => {
  it("writes a descendant and does not mkdir through a symlink parent", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fsp.symlink(outside, path.join(root, "link"));

    const inside = await writeBrowserWorkspaceFile(
      path.join(root, "nested", "ok.txt"),
      "inside",
      root,
    );
    expect(await fsp.readFile(inside, "utf8")).toBe("inside");

    await expect(
      writeBrowserWorkspaceFile(
        path.join(root, "link", "nested", "pwned.txt"),
        "escaped",
        root,
      ),
    ).rejects.toThrow(/escapes the workspace root/);
    await expect(
      fsp.stat(path.join(outside, "nested", "pwned.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws a path_forbidden BrowserWorkspaceError", async () => {
    const root = await makeRoot();
    try {
      await writeBrowserWorkspaceFile("/etc/passwd", "no", root);
      throw new Error("expected throw");
    } catch (error) {
      expect(isBrowserWorkspaceError(error)).toBe(true);
      if (isBrowserWorkspaceError(error)) {
        expect(error.browserWorkspaceErrorCode).toBe("path_forbidden");
      }
    }
  });
});
