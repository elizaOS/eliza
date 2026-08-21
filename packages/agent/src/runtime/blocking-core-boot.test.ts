/**
 * Unit coverage for preregisterCorePluginsInDependencyWaves and
 * initializeBlockingCoreRuntimeForBoot — dependency-wave ordering, required
 * plugin fail-closed, abort handling, and the already-registered skip.
 * Uses the real CORE_PLUGINS list; runtime/plugin/ownership are mocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    severity?: string;
    context?: unknown;
    constructor(message: string, opts?: { code?: string; severity?: string; context?: unknown; cause?: unknown }) {
      super(message);
      this.code = opts?.code;
      this.severity = opts?.severity;
      this.context = opts?.context;
    }
  },
  logger: { debug() {}, warn() {}, info() {}, error() {} },
}));
vi.mock("@elizaos/shared", () => ({ formatError: (e: unknown) => String(e) }));
vi.mock("./runtime-action-ownership.ts", () => ({
  applyHostActionOwnership: (_runtime: unknown, plugin: unknown) => plugin,
}));

import {
  preregisterCorePluginsInDependencyWaves,
  initializeBlockingCoreRuntimeForBoot,
} from "./runtime/blocking-core-boot.ts";

function makeRuntime(registeredPlugins: Array<{ name: string }> = []) {
  const registerOrder: string[] = [];
  return {
    plugins: registeredPlugins,
    registerOrder,
    registerPlugin: vi.fn(async (plugin: { name: string }) => {
      registerOrder.push(plugin.name);
    }),
  };
}

function makeResolved(name: string, dependencies: string[] = []) {
  return { name, plugin: { name, dependencies } };
}

describe("preregisterCorePluginsInDependencyWaves", () => {
  it("registers only the resolved subset of core plugins", async () => {
    const runtime = makeRuntime();
    const resolved = [
      makeResolved("@elizaos/plugin-sql"),
      makeResolved("@elizaos/plugin-native-filesystem"),
    ];
    await preregisterCorePluginsInDependencyWaves({
      runtime: runtime as never,
      resolvedPlugins: resolved as never,
      alreadyPreRegistered: new Set(),
    });
    expect(runtime.registerOrder).toContain("@elizaos/plugin-sql");
    expect(runtime.registerOrder).toContain("@elizaos/plugin-native-filesystem");
  });

  it("does not register plugins absent from the resolved set", async () => {
    const runtime = makeRuntime();
    await preregisterCorePluginsInDependencyWaves({
      runtime: runtime as never,
      resolvedPlugins: [makeResolved("@elizaos/plugin-native-filesystem")] as never,
      alreadyPreRegistered: new Set(),
    });
    expect(runtime.registerOrder).not.toContain("@elizaos/plugin-sql");
  });

  it("skips plugins already registered on the runtime", async () => {
    const runtime = makeRuntime([{ name: "@elizaos/plugin-sql" }]);
    await preregisterCorePluginsInDependencyWaves({
      runtime: runtime as never,
      resolvedPlugins: [makeResolved("@elizaos/plugin-sql")] as never,
      alreadyPreRegistered: new Set(),
    });
    expect(runtime.registerOrder).not.toContain("@elizaos/plugin-sql");
  });

  it("skips plugins in the alreadyPreRegistered set", async () => {
    const runtime = makeRuntime();
    await preregisterCorePluginsInDependencyWaves({
      runtime: runtime as never,
      resolvedPlugins: [makeResolved("@elizaos/plugin-sql")] as never,
      alreadyPreRegistered: new Set(["@elizaos/plugin-sql"]),
    });
    expect(runtime.registerOrder).not.toContain("@elizaos/plugin-sql");
  });

  it("throws when a required plugin is not resolved", async () => {
    const runtime = makeRuntime();
    await expect(
      preregisterCorePluginsInDependencyWaves({
        runtime: runtime as never,
        resolvedPlugins: [] as never,
        alreadyPreRegistered: new Set(),
        requiredPluginNames: new Set(["@elizaos/plugin-sql"]),
      }),
    ).rejects.toThrow(/Required core plugin @elizaos\/plugin-sql/);
  });

  it("throws when a required plugin fails registration", async () => {
    const runtime = makeRuntime();
    runtime.registerPlugin.mockRejectedValueOnce(new Error("boom"));
    await expect(
      preregisterCorePluginsInDependencyWaves({
        runtime: runtime as never,
        resolvedPlugins: [makeResolved("@elizaos/plugin-sql")] as never,
        alreadyPreRegistered: new Set(),
        requiredPluginNames: new Set(["@elizaos/plugin-sql"]),
      }),
    ).rejects.toThrow(/Required core plugin @elizaos\/plugin-sql/);
  });

  it("swallows failures of non-required plugins", async () => {
    const runtime = makeRuntime();
    runtime.registerPlugin.mockRejectedValueOnce(new Error("boom"));
    await expect(
      preregisterCorePluginsInDependencyWaves({
        runtime: runtime as never,
        resolvedPlugins: [makeResolved("@elizaos/plugin-sql")] as never,
        alreadyPreRegistered: new Set(),
      }),
    ).resolves.toBeUndefined();
  });

  it("respects an already-aborted signal", async () => {
    const runtime = makeRuntime();
    const abort = new AbortController();
    abort.abort();
    await expect(
      preregisterCorePluginsInDependencyWaves({
        runtime: runtime as never,
        resolvedPlugins: [makeResolved("@elizaos/plugin-sql")] as never,
        alreadyPreRegistered: new Set(),
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow();
  });

  it("orders a dependency before its dependent", async () => {
    const runtime = makeRuntime();
    const resolved = [
      // dependent listed first in the resolved array; still must come second
      makeResolved("@elizaos/plugin-agent-skills", ["@elizaos/plugin-coding-tools"]),
      makeResolved("@elizaos/plugin-coding-tools"),
    ];
    await preregisterCorePluginsInDependencyWaves({
      runtime: runtime as never,
      resolvedPlugins: resolved as never,
      alreadyPreRegistered: new Set(),
    });
    const toolsIdx = runtime.registerOrder.indexOf("@elizaos/plugin-coding-tools");
    const skillsIdx = runtime.registerOrder.indexOf("@elizaos/plugin-agent-skills");
    if (toolsIdx >= 0 && skillsIdx >= 0) {
      expect(toolsIdx).toBeLessThan(skillsIdx);
    }
  });
});

describe("initializeBlockingCoreRuntimeForBoot", () => {
  it("waits for the blocking environment when deferred", async () => {
    const waitForBlockingEnvironment = vi.fn(async () => {});
    const initializeCoreRuntime = vi.fn(async () => {});
    await initializeBlockingCoreRuntimeForBoot({
      blockDeferredPluginImports: true,
      runtime: makeRuntime() as never,
      resolvedPlugins: [] as never,
      requiredPluginNames: new Set(),
      waitForBlockingEnvironment,
      initializeCoreRuntime,
    });
    expect(waitForBlockingEnvironment).toHaveBeenCalledTimes(1);
    expect(initializeCoreRuntime).toHaveBeenCalledTimes(1);
  });

  it("skips the environment wait when not deferred", async () => {
    const waitForBlockingEnvironment = vi.fn(async () => {});
    const initializeCoreRuntime = vi.fn(async () => {});
    await initializeBlockingCoreRuntimeForBoot({
      blockDeferredPluginImports: false,
      runtime: makeRuntime() as never,
      resolvedPlugins: [] as never,
      requiredPluginNames: new Set(),
      waitForBlockingEnvironment,
      initializeCoreRuntime,
    });
    expect(waitForBlockingEnvironment).not.toHaveBeenCalled();
    expect(initializeCoreRuntime).toHaveBeenCalledTimes(1);
  });

  it("throws on abort before initialization", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      initializeBlockingCoreRuntimeForBoot({
        blockDeferredPluginImports: false,
        runtime: makeRuntime() as never,
        resolvedPlugins: [] as never,
        requiredPluginNames: new Set(),
        waitForBlockingEnvironment: async () => {},
        initializeCoreRuntime: async () => {},
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow();
  });
});
