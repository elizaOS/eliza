/**
 * Workspace plugin scanning against a real on-disk fixture, covering entries
 * that `readdirSync` reports but `statSync` cannot resolve.
 *
 * Discovery runs during `startApiServer`, so a single unreadable directory
 * entry deciding whether the agent boots is the behavior under test here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspacePluginPackages } from "./plugin-discovery-helpers";

const tempRoots: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-plugin-scan-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  return root;
}

function writePlugin(root: string, dirName: string, npmName: string): void {
  const dir = path.join(root, "plugins", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: npmName, version: "1.0.0" }),
    "utf8",
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("discoverWorkspacePluginPackages", () => {
  it("skips a broken symlink and still discovers the real plugins beside it", () => {
    const root = makeWorkspace();
    writePlugin(root, "plugin-alpha", "@elizaos/plugin-alpha");
    fs.symlinkSync(
      path.join(root, "plugins", "plugin-was-removed"),
      path.join(root, "plugins", "plugin-dangling"),
    );

    const discovered = discoverWorkspacePluginPackages(root);

    expect(discovered.map((plugin) => plugin.id)).toEqual(["alpha"]);
  });

  it("resolves a plugin directory reached through a symlink", () => {
    const root = makeWorkspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-external-"));
    tempRoots.push(external);
    fs.writeFileSync(
      path.join(external, "package.json"),
      JSON.stringify({ name: "@elizaos/plugin-linked", version: "1.0.0" }),
      "utf8",
    );
    fs.symlinkSync(external, path.join(root, "plugins", "plugin-linked"));

    const discovered = discoverWorkspacePluginPackages(root);

    expect(discovered.map((plugin) => plugin.id)).toEqual(["linked"]);
  });

  it("ignores plain files sitting in a scan root", () => {
    const root = makeWorkspace();
    writePlugin(root, "plugin-beta", "@elizaos/plugin-beta");
    fs.writeFileSync(
      path.join(root, "plugins", "README.md"),
      "# plugins",
      "utf8",
    );

    const discovered = discoverWorkspacePluginPackages(root);

    expect(discovered.map((plugin) => plugin.id)).toEqual(["beta"]);
  });
});
