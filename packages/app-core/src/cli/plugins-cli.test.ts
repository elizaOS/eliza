import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizePluginName,
  parsePluginSpec,
  validatePluginPath,
} from "./plugins-cli";

const tempDirs: string[] = [];
let originalCwd: string;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-core-plugins-cli-"));
  tempDirs.push(dir);
  return dir;
}

describe("plugins CLI helpers", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes shorthand plugin names and rejects empty names", () => {
    expect(normalizePluginName("discord")).toBe("@elizaos/plugin-discord");
    expect(normalizePluginName(" plugin-browser ")).toBe("plugin-browser");
    expect(normalizePluginName("@scope/plugin-foo")).toBe("@scope/plugin-foo");
    expect(() => normalizePluginName("   ")).toThrow("Plugin name is required");
  });

  it("rejects path-like and whitespace-bearing plugin names before install", () => {
    for (const name of [
      "../plugin-evil",
      "@scope/../plugin-evil",
      "plugin-evil/path",
      "plugin-evil\\path",
      "plugin evil",
      "plugin-evil\nnext",
    ]) {
      expect(() => normalizePluginName(name)).toThrow("Invalid plugin name");
    }
  });

  it("parses plugin specs with optional versions", () => {
    expect(parsePluginSpec("discord@1.2.3")).toEqual({
      name: "@elizaos/plugin-discord",
      version: "1.2.3",
    });
    expect(parsePluginSpec("@scope/plugin-foo@next")).toEqual({
      name: "@scope/plugin-foo",
      version: "next",
    });
    expect(parsePluginSpec("@scope/plugin-foo")).toEqual({
      name: "@scope/plugin-foo",
      version: undefined,
    });
    expect(() => parsePluginSpec("discord@")).toThrow(
      "Plugin version cannot be empty",
    );
    expect(() => parsePluginSpec("discord@latest next")).toThrow(
      "Invalid plugin version",
    );
  });

  it("accepts real plugin paths under cwd or home", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const cwdPluginDir = path.join(cwd, "plugins", "one");
    const homePluginDir = path.join(home, "plugins", "two");
    fs.mkdirSync(cwdPluginDir, { recursive: true });
    fs.mkdirSync(homePluginDir, { recursive: true });
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() => validatePluginPath(cwdPluginDir)).not.toThrow();
    expect(() => validatePluginPath(homePluginDir)).not.toThrow();
  });

  it("rejects paths outside cwd and home after resolving dot segments", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cwd, "plugins"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() =>
      validatePluginPath(path.join(cwd, "plugins", "..", "..", "outside")),
    ).toThrow("outside allowed boundaries");
  });

  it("rejects symlinked plugin paths that escape cwd and home", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const outside = path.join(root, "outside");
    const symlink = path.join(cwd, "plugins", "escape");
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, symlink, "dir");
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() => validatePluginPath(symlink)).toThrow(
      "outside allowed boundaries",
    );
  });
});
