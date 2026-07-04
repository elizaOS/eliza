/**
 * Coverage for the tiered plugin-reload pipeline in `applyPluginRuntimeMutation`.
 * Exercises config_apply, plugin_reload (unload+register), runtime_reload
 * escalation for adapter plugins, and the two-phase ROLLBACK path that restores
 * the previous plugin graph when registerPlugin throws mid-reload so the
 * in-memory graph is never left half-torn-down. Deterministic: the runtime and
 * its lifecycle methods are vi.fn stubs; no live plugins are loaded.
 */
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type { ResolvedPlugin } from "../runtime/plugin-types.ts";
import { applyPluginRuntimeMutation } from "./plugin-runtime-apply.ts";

type LifecycleRuntime = AgentRuntime & {
  applyPluginConfig: ReturnType<typeof vi.fn>;
  registerPlugin: ReturnType<typeof vi.fn>;
  unloadPlugin: ReturnType<typeof vi.fn>;
  reloadPlugin: ReturnType<typeof vi.fn>;
  getPluginOwnership: ReturnType<typeof vi.fn>;
};

const EMPTY_CONFIG = {} as unknown as ElizaConfig;

function resolved(
  packageName: string,
  plugin: { name: string; adapter?: unknown },
): ResolvedPlugin {
  return { name: packageName, plugin: plugin as ResolvedPlugin["plugin"] };
}

function makeRuntime(
  overrides: Partial<Record<keyof LifecycleRuntime, unknown>> = {},
): LifecycleRuntime {
  const runtime = {
    plugins: [],
    getSetting: vi.fn().mockReturnValue(undefined),
    // supportsRuntimePluginLifecycle requires these three to be functions:
    unloadPlugin: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
    getPluginOwnership: vi.fn().mockReturnValue(undefined),
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    applyPluginConfig: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as LifecycleRuntime;
  return runtime;
}

describe("applyPluginRuntimeMutation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns mode 'none' when there is no runtime", async () => {
    const result = await applyPluginRuntimeMutation({
      runtime: null,
      previousConfig: EMPTY_CONFIG,
      nextConfig: EMPTY_CONFIG,
      reason: "no runtime",
    });
    expect(result.mode).toBe("none");
    expect(result.requiresRestart).toBe(false);
  });

  it("applies config in place (mode 'config_apply') without unload/register", async () => {
    const runtime = makeRuntime();
    const plugin = resolved("@elizaos/plugin-x", { name: "x" });
    const result = await applyPluginRuntimeMutation({
      runtime,
      previousConfig: EMPTY_CONFIG,
      nextConfig: EMPTY_CONFIG,
      previousResolvedPlugins: [plugin],
      nextResolvedPlugins: [plugin],
      changedPluginPackage: "@elizaos/plugin-x",
      config: { KEY: "v" },
      reason: "config update",
    });
    expect(result.mode).toBe("config_apply");
    expect(result.appliedConfigPackage).toBe("@elizaos/plugin-x");
    expect(runtime.applyPluginConfig).toHaveBeenCalledWith("x", { KEY: "v" });
    expect(runtime.unloadPlugin).not.toHaveBeenCalled();
    expect(runtime.registerPlugin).not.toHaveBeenCalled();
  });

  it("reloads in place (mode 'plugin_reload') when in-place config apply is unsupported", async () => {
    const runtime = makeRuntime({
      applyPluginConfig: vi.fn().mockResolvedValue(false),
    });
    const previous = resolved("@elizaos/plugin-x", { name: "x" });
    const next = resolved("@elizaos/plugin-x", { name: "x" });
    const result = await applyPluginRuntimeMutation({
      runtime,
      previousConfig: EMPTY_CONFIG,
      nextConfig: EMPTY_CONFIG,
      previousResolvedPlugins: [previous],
      nextResolvedPlugins: [next],
      changedPluginPackage: "@elizaos/plugin-x",
      config: { KEY: "v" },
      reason: "reload x",
    });
    expect(result.mode).toBe("plugin_reload");
    expect(result.reloadedPackages).toEqual(["@elizaos/plugin-x"]);
    expect(runtime.unloadPlugin).toHaveBeenCalledWith("x");
    expect(runtime.registerPlugin).toHaveBeenCalledWith(next.plugin);
  });

  it("rolls back to the previous plugin graph when registerPlugin throws mid-reload", async () => {
    const previousPlugin = { name: "x" };
    const nextPlugin = { name: "x" };
    // First registerPlugin call (the new version) throws; the rollback
    // re-registration of the PREVIOUS version must then succeed.
    const registerPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom: new plugin failed to register"))
      .mockResolvedValue(undefined);
    const runtime = makeRuntime({
      applyPluginConfig: vi.fn().mockResolvedValue(false),
      registerPlugin,
    });

    const result = await applyPluginRuntimeMutation({
      runtime,
      previousConfig: EMPTY_CONFIG,
      nextConfig: EMPTY_CONFIG,
      previousResolvedPlugins: [resolved("@elizaos/plugin-x", previousPlugin)],
      nextResolvedPlugins: [resolved("@elizaos/plugin-x", nextPlugin)],
      changedPluginPackage: "@elizaos/plugin-x",
      config: { KEY: "v" },
      reason: "reload x",
    });

    // We unloaded the old plugin, the new one threw → rollback re-registers the
    // OLD plugin so the runtime is consistent, and we ask for a restart.
    expect(runtime.unloadPlugin).toHaveBeenCalledWith("x");
    expect(registerPlugin).toHaveBeenNthCalledWith(1, nextPlugin); // failed attempt
    expect(registerPlugin).toHaveBeenNthCalledWith(2, previousPlugin); // rollback
    expect(result.mode).toBe("restart_required");
    expect(result.requiresRestart).toBe(true);
    expect(result.restartedRuntime).toBe(false);
    expect(result.reason).toContain("rolled back");
  });

  it("escalates to a runtime restart (mode 'runtime_reload') for adapter plugins", async () => {
    const runtime = makeRuntime();
    const restartRuntime = vi.fn().mockResolvedValue(true);
    const result = await applyPluginRuntimeMutation({
      runtime,
      previousConfig: EMPTY_CONFIG,
      nextConfig: EMPTY_CONFIG,
      previousResolvedPlugins: [],
      // an adapter plugin is being added → cannot hot-reload, must restart
      nextResolvedPlugins: [
        resolved("@elizaos/plugin-sql", { name: "sql", adapter: {} }),
      ],
      reason: "add db adapter",
      restartRuntime,
    });
    expect(restartRuntime).toHaveBeenCalledWith("add db adapter");
    expect(result.mode).toBe("runtime_reload");
    expect(result.restartedRuntime).toBe(true);
    // an added adapter is never hot-registered — it goes through restart
    expect(runtime.registerPlugin).not.toHaveBeenCalled();
  });
});
