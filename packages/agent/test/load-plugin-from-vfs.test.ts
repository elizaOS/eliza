/** Loading a VFS plugin whose name is already registered is refused, not silently skipped. */
import fsp from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkbenchRouteContext } from "../src/api/workbench-context.ts";
import { handleWorkbenchVfsRoutes } from "../src/api/workbench-vfs-routes.ts";
import {
  _resetLoadedVfsPluginsForTests,
  getLoadedVfsPlugins,
  loadPluginFromVfs,
} from "../src/runtime/load-plugin-from-vfs.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const originalStateDir = process.env.ELIZA_STATE_DIR;
let stateDir: string;

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-plugin-load-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  _resetLoadedVfsPluginsForTests();
});

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalStateDir;
  _resetLoadedVfsPluginsForTests();
  await fsp.rm(stateDir, { recursive: true, force: true });
});

/** Mirrors core AgentRuntime.registerPlugin: an existing name is skipped. */
function fakeRuntime() {
  const plugins: Plugin[] = [];
  const runtime = {
    plugins,
    async registerPlugin(plugin: Plugin) {
      if (plugins.some((existing) => existing.name === plugin.name)) return;
      plugins.push(plugin);
    },
  };
  return runtime as unknown as AgentRuntime & { plugins: Plugin[] };
}

async function projectWithPlugin(version: string) {
  const vfs = new VirtualFilesystemService({ projectId: "plugins" });
  await vfs.initialize();
  await vfs.writeFile(
    "plugin.mjs",
    `export default { name: "vfs-demo", description: "${version}" };\n`,
  );
  return vfs;
}

describe("loadPluginFromVfs", () => {
  it("refuses a second load of the same name and keeps the old plugin", async () => {
    const runtime = fakeRuntime();
    const vfs = await projectWithPlugin("v1");
    await loadPluginFromVfs({
      runtime,
      vfs,
      entry: "plugin.mjs",
      compileFirst: false,
    });
    const firstLoadedAt = getLoadedVfsPlugins()[0]?.loadedAt;

    await vfs.writeFile(
      "plugin.mjs",
      `export default { name: "vfs-demo", description: "v2" };\n`,
    );
    await expect(
      loadPluginFromVfs({
        runtime,
        vfs,
        entry: "plugin.mjs",
        compileFirst: false,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_ALREADY_LOADED" });

    expect(runtime.plugins.map((plugin) => plugin.description)).toEqual(["v1"]);
    expect(getLoadedVfsPlugins()).toHaveLength(1);
    expect(getLoadedVfsPlugins()[0]?.loadedAt).toBe(firstLoadedAt);
  });

  it("returns 409 from the load-plugin route", async () => {
    const runtime = fakeRuntime();
    const vfs = await projectWithPlugin("v1");
    await loadPluginFromVfs({
      runtime,
      vfs,
      entry: "plugin.mjs",
      compileFirst: false,
    });

    const errors: Array<{ message: string; status?: number }> = [];
    const ctx = {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/workbench/vfs/projects/plugins/load-plugin",
      url: new URL("http://localhost/"),
      state: { runtime, adminEntityId: null },
      json: () => {
        throw new Error("expected an error response");
      },
      error: (_res: unknown, message: string, status?: number) =>
        errors.push({ message, status }),
      readJsonBody: async () =>
        ({ entry: "plugin.mjs", compileFirst: false }) as never,
      decodePathComponent: (raw: string) => decodeURIComponent(raw),
    } as unknown as WorkbenchRouteContext;

    expect(await handleWorkbenchVfsRoutes(ctx)).toBe(true);
    expect(errors).toEqual([
      {
        message: expect.stringContaining("already loaded"),
        status: 409,
      },
    ]);
    expect(runtime.plugins).toHaveLength(1);
  });
});
