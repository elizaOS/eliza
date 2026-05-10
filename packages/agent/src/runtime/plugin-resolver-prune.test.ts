import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneStalePluginInstances } from "./plugin-resolver.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "plugin-resolver-prune-"),
  );
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function createInstance(name: string, ageMs: number): Promise<string> {
  const dir = path.join(tmpDir, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "marker"), name);
  const time = Date.now() - ageMs;
  await fsp.utimes(dir, time / 1000, time / 1000);
  return dir;
}

describe("pruneStalePluginInstances", () => {
  it("keeps newest N directories and deletes older siblings", async () => {
    await createInstance("oldest", 30 * 60 * 1000);
    await createInstance("older", 20 * 60 * 1000);
    await createInstance("middle", 10 * 60 * 1000);
    await createInstance("newer", 5 * 60 * 1000);
    await createInstance("newest", 1 * 60 * 1000);

    await pruneStalePluginInstances(tmpDir, 3);

    const remaining = (await fsp.readdir(tmpDir)).sort();
    expect(remaining).toEqual(["middle", "newer", "newest"]);
  });

  it("is a no-op when sibling count is at or below the keep limit", async () => {
    await createInstance("a", 10 * 60 * 1000);
    await createInstance("b", 5 * 60 * 1000);

    await pruneStalePluginInstances(tmpDir, 3);

    const remaining = (await fsp.readdir(tmpDir)).sort();
    expect(remaining).toEqual(["a", "b"]);
  });

  it("ignores non-directory entries", async () => {
    await createInstance("dir-a", 10 * 60 * 1000);
    await createInstance("dir-b", 5 * 60 * 1000);
    await createInstance("dir-c", 1 * 60 * 1000);
    await fsp.writeFile(path.join(tmpDir, "stray.txt"), "stray");

    await pruneStalePluginInstances(tmpDir, 1);

    const remaining = (await fsp.readdir(tmpDir)).sort();
    expect(remaining).toEqual(["dir-c", "stray.txt"]);
  });

  it("returns silently when staging dir does not exist", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    await expect(
      pruneStalePluginInstances(missing, 3),
    ).resolves.toBeUndefined();
  });
});
