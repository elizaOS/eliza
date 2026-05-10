import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualFilesystemService } from "../services/virtual-filesystem.ts";
import {
  _resetLoadedVfsPluginsForTests,
  getLoadedVfsPlugins,
  loadPluginFromVfs,
  unloadPluginFromVfs,
} from "./load-plugin-from-vfs.ts";

let tmpDir: string;

beforeEach(async () => {
  _resetLoadedVfsPluginsForTests();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-load-vfs-plugin-"));
});

afterEach(async () => {
  _resetLoadedVfsPluginsForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function createVfs(projectId = "load-plugin-test"): VirtualFilesystemService {
  return new VirtualFilesystemService({
    projectId,
    stateDir: tmpDir,
    quotaBytes: 4 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
  });
}

const TINY_PLUGIN_TS = `
export default {
  name: "vfs-loader-test-plugin",
  description: "Test plugin loaded from VFS.",
  actions: [
    {
      name: "VFS_LOADER_PING",
      description: "responds with pong",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ pong: true }),
    },
  ],
};
`;

describe("loadPluginFromVfs", () => {
  it("compiles, imports, registers, and then unloads a VFS-sourced plugin", async () => {
    const vfs = createVfs();
    await vfs.initialize();
    await vfs.writeFile("src/plugin.ts", TINY_PLUGIN_TS);

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    expect(typeof runtime.registerPlugin).toBe("function");
    expect(
      typeof (runtime as { unloadPlugin?: unknown }).unloadPlugin,
    ).toBe("function");

    const loaded = await loadPluginFromVfs({
      runtime,
      vfs,
      entry: "src/plugin.ts",
      projectId: "load-plugin-test",
    });

    expect(loaded.pluginName).toBe("vfs-loader-test-plugin");
    expect(loaded.unloaded).toBe(false);

    const action = runtime.actions.find(
      (candidate) => candidate.name === "VFS_LOADER_PING",
    );
    expect(action).toBeDefined();
    const handlerResult = (await action?.handler?.(
      runtime as unknown as never,
      {} as never,
      {} as never,
    )) as { pong?: boolean } | undefined;
    expect(handlerResult?.pong).toBe(true);

    expect(getLoadedVfsPlugins().map((entry) => entry.pluginName)).toContain(
      "vfs-loader-test-plugin",
    );

    const unloadResult = await unloadPluginFromVfs({
      runtime,
      pluginName: "vfs-loader-test-plugin",
    });
    expect(unloadResult.unloaded).toBe(true);
    expect(
      runtime.actions.some(
        (candidate) => candidate.name === "VFS_LOADER_PING",
      ),
    ).toBe(false);
    expect(getLoadedVfsPlugins()).toHaveLength(0);
  });

  it("loads a pre-built JS plugin without recompiling", async () => {
    const vfs = createVfs("prebuilt-test");
    await vfs.initialize();
    await vfs.writeFile(
      "dist/plugin.js",
      `export default { name: "prebuilt-vfs-plugin", description: "no-compile path" };
`,
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });

    const loaded = await loadPluginFromVfs({
      runtime,
      vfs,
      entry: "dist/plugin.js",
      compileFirst: false,
    });

    expect(loaded.pluginName).toBe("prebuilt-vfs-plugin");

    await unloadPluginFromVfs({
      runtime,
      pluginName: "prebuilt-vfs-plugin",
    });
  });
});
