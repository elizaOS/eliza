/**
 * End-to-end coverage of the on-disk directory plugin (un)loader
 * (`load-plugin-from-directory.ts`): entry resolution from package.json, the
 * `dist/index.js` fallback, view registration, and the path-escape / symlink and
 * bad-export rejections. Real harness — a live `AgentRuntime`, plugins
 * scaffolded into OS temp dirs, and genuine ESM dynamic import; nothing mocked.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLoadedDirectoryPluginsForTests,
  getLoadedDirectoryPlugins,
  loadPluginFromDirectory,
  unloadPluginFromDirectory,
} from "./load-plugin-from-directory.ts";

let tmpDir: string;

beforeEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-load-dir-plugin-"));
});

afterEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

const PREBUILT_PLUGIN_JS = `
export default {
  name: "dir-loader-test-plugin",
  description: "Test plugin loaded from a directory.",
  actions: [
    {
      name: "DIR_LOADER_PING",
      description: "responds with pong",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ pong: true }),
    },
  ],
};
`;

async function scaffold(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const root = path.join(tmpDir, dir);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return root;
}

describe("loadPluginFromDirectory", () => {
  it("imports, registers, and unloads a built plugin resolved from package.json main", async () => {
    const dir = await scaffold(
      "plugin-dir-loader",
      { name: "@local/plugin-dir-loader", main: "dist/index.js" },
      { "dist/index.js": PREBUILT_PLUGIN_JS },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    expect(typeof runtime.registerPlugin).toBe("function");

    const loaded = await loadPluginFromDirectory({ runtime, directory: dir });
    expect(loaded.pluginName).toBe("dir-loader-test-plugin");
    expect(loaded.loaded).toBe(true);

    const action = runtime.actions.find((a) => a.name === "DIR_LOADER_PING");
    expect(action).toBeDefined();
    const result = (await action?.handler?.(
      runtime as unknown as never,
      {} as never,
      {} as never,
    )) as { pong?: boolean } | undefined;
    expect(result?.pong).toBe(true);

    expect(getLoadedDirectoryPlugins().map((e) => e.pluginName)).toContain(
      "dir-loader-test-plugin",
    );

    const unloaded = await unloadPluginFromDirectory({
      runtime,
      pluginName: "dir-loader-test-plugin",
    });
    expect(unloaded.unloaded).toBe(true);
    expect(runtime.actions.some((a) => a.name === "DIR_LOADER_PING")).toBe(
      false,
    );
    expect(getLoadedDirectoryPlugins()).toHaveLength(0);
  });

  it("falls back to dist/index.js when package.json has no usable entry", async () => {
    const dir = await scaffold(
      "plugin-fallback",
      // main points at TS source (not loadable) → loader must skip it.
      { name: "@local/plugin-fallback", main: "src/index.ts" },
      {
        "dist/index.js": `export const plugin = { name: "fallback-dir-plugin" };`,
      },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const loaded = await loadPluginFromDirectory({ runtime, directory: dir });
    expect(loaded.pluginName).toBe("fallback-dir-plugin");

    await unloadPluginFromDirectory({
      runtime,
      pluginName: "fallback-dir-plugin",
    });
  });

  it("registers a view-contributing plugin's views via registerPlugin", async () => {
    const dir = await scaffold(
      "plugin-with-view",
      { name: "@local/plugin-with-view", main: "dist/index.js" },
      {
        "dist/index.js": `export default {
  name: "view-dir-plugin",
  description: "contributes a view",
  views: [
    {
      id: "dir-loaded-view",
      label: "Dir Loaded",
      path: "/dir-loaded",
      bundlePath: "dist/views/bundle.js",
      componentExport: "DirLoadedView",
    },
  ],
};
`,
      },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const loaded = await loadPluginFromDirectory({ runtime, directory: dir });
    expect(loaded.pluginName).toBe("view-dir-plugin");

    // registerPlugin must not throw on a views-bearing plugin; the lifecycle
    // wrapper registers the views. (View bundle resolution is exercised by the
    // views-registry tests; here we only assert registration succeeds.)
    await unloadPluginFromDirectory({ runtime, pluginName: "view-dir-plugin" });
  });

  it("throws a clear error when the directory has no built entry", async () => {
    const dir = await scaffold(
      "plugin-empty",
      { name: "@local/plugin-empty" },
      {},
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await expect(
      loadPluginFromDirectory({ runtime, directory: dir }),
    ).rejects.toThrow(/no built entry/);
  });

  it("rejects an explicit absolute entry outside the plugin directory", async () => {
    const dir = await scaffold(
      "plugin-explicit-entry",
      { name: "@local/plugin-explicit-entry", main: "dist/index.js" },
      { "dist/index.js": PREBUILT_PLUGIN_JS },
    );
    const outside = path.join(tmpDir, "outside.js");
    await fsp.writeFile(outside, PREBUILT_PLUGIN_JS);

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await expect(
      loadPluginFromDirectory({ runtime, directory: dir, entry: outside }),
    ).rejects.toThrow(
      /explicit entry must be a relative built JavaScript path/,
    );
  });

  it("rejects package entries that resolve through a symlink outside the plugin directory", async () => {
    const outside = path.join(tmpDir, "outside.js");
    await fsp.writeFile(outside, PREBUILT_PLUGIN_JS);
    const dir = await scaffold(
      "plugin-symlink-entry",
      { name: "@local/plugin-symlink-entry", main: "dist/index.js" },
      {},
    );
    await fsp.mkdir(path.join(dir, "dist"), { recursive: true });
    await fsp.symlink(outside, path.join(dir, "dist/index.js"));

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await expect(
      loadPluginFromDirectory({ runtime, directory: dir }),
    ).rejects.toThrow(/entry must stay inside plugin directory/);
  });

  it("throws when the entry exports no valid plugin", async () => {
    const dir = await scaffold(
      "plugin-noexport",
      { name: "@local/plugin-noexport", main: "dist/index.js" },
      { "dist/index.js": `export const notAPlugin = 42;` },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await expect(
      loadPluginFromDirectory({ runtime, directory: dir }),
    ).rejects.toThrow(/no valid plugin export/);
  });
});
