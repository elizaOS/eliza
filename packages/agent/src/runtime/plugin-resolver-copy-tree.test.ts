/**
 * Real-fs tests for plugin staging copies that must not follow out-of-tree
 * symlinks. Origin `fs.cp({ dereference: true })` materialized host file
 * bytes into the staged tree. Deterministic temp directories, no mocks.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  confinedStagingSymlinkTarget,
  copyPluginTreeWithoutEscapingSymlinks,
} from "./plugin-resolver.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

describe("copyPluginTreeWithoutEscapingSymlinks", () => {
  it("copies regular files and in-tree symlinks", async () => {
    const src = await makeDir("plugin-copy-src-");
    const dst = await makeDir("plugin-copy-dst-");
    await fsp.writeFile(path.join(src, "ok.txt"), "inside");
    await fsp.symlink(path.join(src, "ok.txt"), path.join(src, "alias.txt"));

    const target = path.join(dst, "tree");
    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    expect(await fsp.readFile(path.join(target, "ok.txt"), "utf8")).toBe(
      "inside",
    );
    const alias = path.join(target, "alias.txt");
    expect((await fsp.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(alias, "utf8")).toBe("inside");
  });

  it("does not materialize a host file behind an out-of-tree symlink", async () => {
    const secretDir = await makeDir("plugin-copy-secret-");
    const secret = path.join(secretDir, "secret.txt");
    await fsp.writeFile(secret, "HOST-SECRET");

    const src = await makeDir("plugin-copy-src-");
    const dst = await makeDir("plugin-copy-dst-");
    await fsp.writeFile(path.join(src, "ok.txt"), "inside");
    await fsp.symlink(secret, path.join(src, "leaked.txt"));

    const target = path.join(dst, "tree");
    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    expect(await fsp.readFile(path.join(target, "ok.txt"), "utf8")).toBe(
      "inside",
    );
    await expect(
      fsp.lstat(path.join(target, "leaked.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("confinedStagingSymlinkTarget", () => {
  it("rejects a symlink whose realpath is outside the workspace", async () => {
    const secretDir = await makeDir("plugin-link-secret-");
    const secret = path.join(secretDir, "secret.txt");
    await fsp.writeFile(secret, "HOST-SECRET");
    const src = await makeDir("plugin-link-src-");
    const link = path.join(src, "escape");
    await fsp.symlink(secret, link);
    expect(await confinedStagingSymlinkTarget(link)).toBeNull();
  });

  it("accepts a symlink that stays inside the source tree", async () => {
    const src = await makeDir("plugin-link-src-");
    const file = path.join(src, "ok.txt");
    await fsp.writeFile(file, "inside");
    const link = path.join(src, "alias");
    await fsp.symlink(file, link);
    expect(await confinedStagingSymlinkTarget(link, src)).toBe(
      fs.realpathSync(file),
    );
  });
});
