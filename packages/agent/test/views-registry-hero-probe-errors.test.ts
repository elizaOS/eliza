/**
 * Hero probing must separate "this file is absent" from "this file cannot be
 * read". Only an absent path answers "no hero"; a permission or IO failure on
 * a hero that is on disk is a real fault, and reporting it as absence makes the
 * registry publish a generated placeholder for a packaged hero with no signal.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findHeroOnDisk } from "../src/api/views-registry.ts";

const createdDirs: string[] = [];

async function makePluginDirWithHero(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-hero-probe-"));
  createdDirs.push(dir);
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "hero.png"), "png-bytes");
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const dirs = createdDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("findHeroOnDisk", () => {
  it("propagates an unreadable hero instead of reporting it as missing", async () => {
    const pluginDir = await makePluginDirWithHero();
    vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(
        new Error(
          `EACCES: permission denied, access '${path.join(pluginDir, "assets", "hero.png")}'`,
        ),
        { code: "EACCES", errno: -13, syscall: "access" },
      ),
    );

    await expect(findHeroOnDisk({ pluginDir })).rejects.toThrow(/EACCES/);
  });

  it("still reports a hero that is genuinely absent as no hero", async () => {
    const pluginDir = await makePluginDirWithHero();
    vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
        errno: -2,
        syscall: "access",
      }),
    );

    await expect(findHeroOnDisk({ pluginDir })).resolves.toBeNull();
  });
});
