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
  getBundleDiskPath,
  getView,
  unregisterPluginViews,
} from "../api/views-registry.ts";
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
  unregisterPluginViews("view-dir-plugin");
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

function reloadableViewPluginSource(
  version: string,
  options: { bundlePath?: string; failInit?: boolean } = {},
): string {
  const bundlePath = options.bundlePath ?? "dist/views/bundle.js";
  return `export default {
  name: "view-dir-plugin",
  description: "contributes an editable view",
  ${options.failInit ? 'init: async () => { throw new Error("replacement init failed"); },' : ""}
  actions: [{
    name: "EDITABLE_VIEW_VERSION",
    description: "reports the loaded edit version",
    examples: [],
    similes: [],
    validate: async () => true,
    handler: async () => ({ version: "${version}" }),
  }],
  views: [{
    id: "dir-loaded-view",
    label: "Dir Loaded ${version}",
    path: "/dir-loaded",
    bundlePath: "${bundlePath}",
    componentExport: "DirLoadedView",
  }],
};\n`;
}

async function expectIncumbentViewPlugin(
  runtime: AgentRuntime,
  incumbentDirectory: string,
): Promise<void> {
  const realIncumbentDirectory = await fsp.realpath(incumbentDirectory);
  expect(getView("dir-loaded-view")).toMatchObject({
    label: "Dir Loaded v1",
    pluginDir: realIncumbentDirectory,
    available: true,
  });
  expect(
    runtime.plugins.filter((plugin) => plugin.name === "view-dir-plugin"),
  ).toHaveLength(1);
  const actions = runtime.actions.filter(
    (action) => action.name === "EDITABLE_VIEW_VERSION",
  );
  expect(actions).toHaveLength(1);
  await expect(
    actions[0]?.handler?.(runtime as never, {} as never, {} as never),
  ).resolves.toEqual({ version: "v1" });
  expect(getLoadedDirectoryPlugins()).toEqual([
    expect.objectContaining({
      pluginName: "view-dir-plugin",
      directory: realIncumbentDirectory,
    }),
  ]);
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
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'directory build'; }\n",
      },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const loaded = await loadPluginFromDirectory({ runtime, directory: dir });
    expect(loaded.pluginName).toBe("view-dir-plugin");
    const realDir = await fsp.realpath(dir);

    const view = getView("dir-loaded-view");
    expect(view).toMatchObject({
      pluginName: "view-dir-plugin",
      pluginDir: realDir,
      available: true,
    });
    expect(getBundleDiskPath(view as NonNullable<typeof view>)).toBe(
      path.join(realDir, "dist/views/bundle.js"),
    );

    await unloadPluginFromDirectory({ runtime, pluginName: "view-dir-plugin" });
    expect(getView("dir-loaded-view")).toBeUndefined();
  });

  it("reloads an edited directory plugin against the rebuilt view bundle", async () => {
    const pluginSource = (version: string) => `export default {
  name: "view-dir-plugin",
  description: "contributes an editable view",
  actions: [{
    name: "EDITABLE_VIEW_VERSION",
    description: "reports the loaded edit version",
    examples: [],
    similes: [],
    validate: async () => true,
    handler: async () => ({ version: "${version}" }),
  }],
  views: [{
    id: "dir-loaded-view",
    label: "Dir Loaded ${version}",
    path: "/dir-loaded",
    bundlePath: "dist/views/bundle.js",
    componentExport: "DirLoadedView",
  }],
};\n`;
    const dir = await scaffold(
      "plugin-with-edited-view",
      { name: "@local/plugin-with-edited-view", main: "dist/index.js" },
      {
        "dist/index.js": pluginSource("v1"),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v1'; }\n",
      },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const realDir = await fsp.realpath(dir);

    await loadPluginFromDirectory({ runtime, directory: dir });
    const initial = getView("dir-loaded-view");
    expect(initial?.label).toBe("Dir Loaded v1");
    expect(initial?.available).toBe(true);
    const initialAction = runtime.actions.find(
      (action) => action.name === "EDITABLE_VIEW_VERSION",
    );
    await expect(
      initialAction?.handler?.(runtime as never, {} as never, {} as never),
    ).resolves.toEqual({ version: "v1" });

    await fsp.writeFile(path.join(dir, "dist/index.js"), pluginSource("v2"));
    await fsp.writeFile(
      path.join(dir, "dist/views/bundle.js"),
      "export function DirLoadedView(){ return 'v2'; }\n",
    );
    await loadPluginFromDirectory({ runtime, directory: dir });
    const edited = getView("dir-loaded-view");
    expect(edited).toMatchObject({
      label: "Dir Loaded v2",
      pluginDir: realDir,
      available: true,
    });
    expect(edited?.bundleHash).not.toBe(initial?.bundleHash);
    expect(getLoadedDirectoryPlugins()).toHaveLength(1);
    expect(
      runtime.plugins.filter((plugin) => plugin.name === "view-dir-plugin"),
    ).toHaveLength(1);
    const editedActions = runtime.actions.filter(
      (action) => action.name === "EDITABLE_VIEW_VERSION",
    );
    expect(editedActions).toHaveLength(1);
    await expect(
      editedActions[0]?.handler?.(runtime as never, {} as never, {} as never),
    ).resolves.toEqual({ version: "v2" });

    await unloadPluginFromDirectory({ runtime, pluginName: "view-dir-plugin" });
  });

  it("preserves the working incumbent when a replacement view bundle is missing", async () => {
    const incumbentDir = await scaffold(
      "plugin-view-incumbent-missing-replacement",
      { name: "@local/plugin-view-incumbent", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v1"),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v1'; }\n",
      },
    );
    const replacementDir = await scaffold(
      "plugin-view-replacement-missing-bundle",
      { name: "@local/plugin-view-replacement", main: "dist/index.js" },
      { "dist/index.js": reloadableViewPluginSource("v2") },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });

    await loadPluginFromDirectory({ runtime, directory: incumbentDir });
    const incumbent = runtime.plugins.find(
      (plugin) => plugin.name === "view-dir-plugin",
    );

    await expect(
      loadPluginFromDirectory({ runtime, directory: replacementDir }),
    ).rejects.toMatchObject({ code: "PLUGIN_DIRECTORY_VIEW_ASSET_MISSING" });
    expect(
      runtime.plugins.find((plugin) => plugin.name === "view-dir-plugin"),
    ).toBe(incumbent);
    await expectIncumbentViewPlugin(runtime, incumbentDir);
  });

  it("preserves the working incumbent when a replacement bundle path escapes its package", async () => {
    const incumbentDir = await scaffold(
      "plugin-view-incumbent-escaping-replacement",
      { name: "@local/plugin-view-incumbent", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v1"),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v1'; }\n",
      },
    );
    const replacementDir = await scaffold(
      "plugin-view-replacement-escaping-bundle",
      { name: "@local/plugin-view-replacement", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v2", {
          bundlePath: "../outside-view.js",
        }),
      },
    );
    await fsp.writeFile(
      path.join(tmpDir, "outside-view.js"),
      "export function DirLoadedView(){ return 'outside'; }\n",
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });

    await loadPluginFromDirectory({ runtime, directory: incumbentDir });
    const incumbent = runtime.plugins.find(
      (plugin) => plugin.name === "view-dir-plugin",
    );

    await expect(
      loadPluginFromDirectory({ runtime, directory: replacementDir }),
    ).rejects.toMatchObject({ code: "PLUGIN_DIRECTORY_VIEW_ASSET_MISSING" });
    expect(
      runtime.plugins.find((plugin) => plugin.name === "view-dir-plugin"),
    ).toBe(incumbent);
    await expectIncumbentViewPlugin(runtime, incumbentDir);
  });

  it("preserves the working incumbent when the replacement module is malformed", async () => {
    const incumbentDir = await scaffold(
      "plugin-view-incumbent-malformed-module",
      { name: "@local/plugin-view-incumbent", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v1"),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v1'; }\n",
      },
    );
    const replacementDir = await scaffold(
      "plugin-view-replacement-malformed-module",
      { name: "@local/plugin-view-replacement", main: "dist/index.js" },
      { "dist/index.js": "export default { name: ;" },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });

    await loadPluginFromDirectory({ runtime, directory: incumbentDir });
    const incumbent = runtime.plugins.find(
      (plugin) => plugin.name === "view-dir-plugin",
    );

    await expect(
      loadPluginFromDirectory({ runtime, directory: replacementDir }),
    ).rejects.toThrow();
    expect(
      runtime.plugins.find((plugin) => plugin.name === "view-dir-plugin"),
    ).toBe(incumbent);
    await expectIncumbentViewPlugin(runtime, incumbentDir);
  });

  it("restores the working incumbent when replacement lifecycle registration fails", async () => {
    const incumbentDir = await scaffold(
      "plugin-view-incumbent-failed-lifecycle",
      { name: "@local/plugin-view-incumbent", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v1"),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v1'; }\n",
      },
    );
    const replacementDir = await scaffold(
      "plugin-view-replacement-failed-lifecycle",
      { name: "@local/plugin-view-replacement", main: "dist/index.js" },
      {
        "dist/index.js": reloadableViewPluginSource("v2", {
          failInit: true,
        }),
        "dist/views/bundle.js":
          "export function DirLoadedView(){ return 'v2'; }\n",
      },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });

    await loadPluginFromDirectory({ runtime, directory: incumbentDir });
    const incumbent = runtime.plugins.find(
      (plugin) => plugin.name === "view-dir-plugin",
    );

    await expect(
      loadPluginFromDirectory({ runtime, directory: replacementDir }),
    ).rejects.toMatchObject({
      code: "PLUGIN_DIRECTORY_RELOAD_FAILED",
      cause: expect.objectContaining({ message: "replacement init failed" }),
    });
    expect(
      runtime.plugins.find((plugin) => plugin.name === "view-dir-plugin"),
    ).toBe(incumbent);
    await expectIncumbentViewPlugin(runtime, incumbentDir);
  });

  it("rejects a declared view whose build did not produce its bundle", async () => {
    const dir = await scaffold(
      "plugin-with-missing-view-build",
      { name: "@local/plugin-with-missing-view-build", main: "dist/index.js" },
      {
        "dist/index.js": `export default {
  name: "view-dir-plugin",
  description: "declares an unbuilt view",
  views: [{
    id: "dir-loaded-view",
    label: "Dir Loaded",
    path: "/dir-loaded",
    bundlePath: "dist/views/bundle.js",
  }],
};\n`,
      },
    );
    const runtime = new AgentRuntime({ logLevel: "fatal" });

    await expect(
      loadPluginFromDirectory({ runtime, directory: dir }),
    ).rejects.toMatchObject({ code: "PLUGIN_DIRECTORY_VIEW_ASSET_MISSING" });
    expect(
      runtime.plugins.some((plugin) => plugin.name === "view-dir-plugin"),
    ).toBe(false);
    expect(getView("dir-loaded-view")).toBeUndefined();
    expect(getLoadedDirectoryPlugins()).toHaveLength(0);
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
