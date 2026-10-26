/**
 * Asset probing must separate "this file is absent" from "this file cannot be
 * read". Only an absent path answers "no asset"; a permission or IO failure on
 * a file that is on disk is a real fault, and reporting it as absence makes the
 * registry publish a generated placeholder for a packaged hero — or register a
 * view bundle as unavailable — with no signal.
 */
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  findHeroOnDisk,
  getView,
  registerPluginViews,
} from "../src/api/views-registry.ts";

const createdDirs: string[] = [];
const createdRuntimes: AgentRuntime[] = [];
const lockedPaths: string[] = [];

/**
 * The unreadable cases below revoke read permission for real instead of
 * mocking `fs.access`, because a mock cannot tell `F_OK` from `R_OK` — and the
 * probe under test is exactly the thing that must get that right. `chmod 0o000`
 * only denies reads to a non-root POSIX caller, so probe that once and skip the
 * cases with a stated reason everywhere else rather than faking the error.
 */
const canRevokeRead = await (async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-chmod-probe-"));
  const probe = path.join(dir, "probe");
  try {
    await fs.writeFile(probe, "x");
    await fs.chmod(probe, 0o000);
    await fs.access(probe, fsConstants.R_OK);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES";
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})();

async function makePluginDirWithHero(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-hero-probe-"));
  createdDirs.push(dir);
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "hero.png"), "png-bytes");
  return dir;
}

/** Make a file that exists but that this process cannot read. */
async function makeUnreadable(file: string): Promise<void> {
  lockedPaths.push(file);
  await fs.chmod(file, 0o000);
}

function makeRuntime(name: string): AgentRuntime {
  const runtime = new AgentRuntime({
    character: createCharacter({ name }),
    enableAutonomy: false,
  });
  createdRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(createdRuntimes.splice(0).map((runtime) => runtime.stop()));
  // Restore permissions before removing the tree: a locked file is still
  // unlinkable through its parent, but leaving it locked hides mistakes.
  await Promise.all(
    lockedPaths.splice(0).map((file) => fs.chmod(file, 0o600).catch(() => {})),
  );
  const dirs = createdDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("findHeroOnDisk", () => {
  it.skipIf(!canRevokeRead)(
    "propagates an unreadable hero instead of reporting it as missing",
    async () => {
      const pluginDir = await makePluginDirWithHero();
      await makeUnreadable(path.join(pluginDir, "assets", "hero.png"));

      await expect(findHeroOnDisk({ pluginDir })).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it("still reports a hero that is genuinely absent as no hero", async () => {
    const pluginDir = await makePluginDirWithHero();
    await fs.rm(path.join(pluginDir, "assets", "hero.png"));

    await expect(findHeroOnDisk({ pluginDir })).resolves.toBeNull();
  });
});

/**
 * `buildEntry` needs no unreadable-asset case of its own, and this file must not
 * pretend to pin one. A declared bundle/frame path is resolved through the
 * realpath confinement first, which answers `undefined` for every non-`ENOENT`
 * resolution failure, so an unreadable parent never reaches the probe; when the
 * file itself is unreadable, `F_OK` succeeds and `captureViewAssetRoot` fails
 * loudly on the read. No reachable input makes the bundle path answer
 * "unavailable" for an asset that is present, so a test asserting EACCES there
 * passes before and after this change and would only add false evidence.
 */
describe("registerPluginViews bundle capture", () => {
  it("still registers a view whose bundle is genuinely absent", async () => {
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-bundle-"));
    createdDirs.push(pluginDir);
    const runtime = makeRuntime("Absent bundle");
    const plugin: Plugin = {
      name: "bundle-probe",
      description: "Absent bundle fixture",
      views: [
        { id: "bundle-view", label: "Bundle view", bundlePath: "view.js" },
      ],
    };

    await registerPluginViews(runtime, plugin, { pluginDir });

    expect(getView(runtime, "bundle-view")?.available).toBe(false);
  });
});
