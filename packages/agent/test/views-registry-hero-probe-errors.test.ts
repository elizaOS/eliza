/**
 * Asset probing must separate "this file is absent" from "this file cannot be
 * read". Only an absent path answers "no asset"; a permission or IO failure on
 * a file that is on disk is a real fault, and reporting it as absence makes the
 * registry publish a generated placeholder for a packaged hero — or register a
 * view bundle as unavailable — with no signal.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findHeroOnDisk,
  getView,
  registerPluginViews,
} from "../src/api/views-registry.ts";

const createdDirs: string[] = [];
const createdRuntimes: AgentRuntime[] = [];

async function makePluginDirWithHero(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-hero-probe-"));
  createdDirs.push(dir);
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "hero.png"), "png-bytes");
  return dir;
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
  vi.restoreAllMocks();
  await Promise.all(createdRuntimes.splice(0).map((runtime) => runtime.stop()));
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

describe("registerPluginViews bundle capture", () => {
  it("propagates an unreadable bundle instead of registering the view as unavailable", async () => {
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-bundle-"));
    createdDirs.push(pluginDir);
    const bundleFile = path.join(pluginDir, "view.js");
    await fs.writeFile(bundleFile, "export const x = 1;");
    // Reject only the bundle probe. Every other access (the hero probe that runs
    // later for the same view) must reach the real filesystem, otherwise this
    // test would pass on the hero throw without ever exercising the bundle path.
    const realAccess = fs.access.bind(fs);
    const accessSpy = vi.spyOn(fs, "access");
    accessSpy.mockImplementation(async (target, mode) => {
      if (String(target) === bundleFile) {
        throw Object.assign(
          new Error(`EACCES: permission denied, access '${bundleFile}'`),
          { code: "EACCES", errno: -13, syscall: "access" },
        );
      }
      return realAccess(target, mode);
    });
    const plugin: Plugin = {
      name: "bundle-probe",
      description: "Unreadable bundle fixture",
      views: [
        { id: "bundle-view", label: "Bundle view", bundlePath: "view.js" },
      ],
    };

    await expect(
      registerPluginViews(makeRuntime("Unreadable bundle"), plugin, {
        pluginDir,
      }),
    ).rejects.toThrow(/EACCES/);
  });

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
