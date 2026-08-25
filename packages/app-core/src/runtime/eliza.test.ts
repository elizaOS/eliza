/**
 * Unit coverage for app-core's Eliza runtime loader: public wrappers around
 * `@elizaos/agent` start/boot, orchestrator env defaulting, PGlite startup-error
 * translation, drop-in plugin scanning, and the server-only host branch. Drives
 * the real module. Upstream `startEliza` / `bootElizaRuntime` and the repair /
 * server-host collaborators are stubbed so the suite does not bind a port or
 * boot a live runtime; plugin collection, cloud-env projection, scanning, and
 * embedding-dimension defaults run against the real implementations.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import type { AgentRuntime } from "@elizaos/core";
import { PGLITE_ERROR_CODES } from "@elizaos/plugin-sql";
import type { ElizaConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_PLUGIN_MAP as sourceChannelPluginMap } from "./channel-plugin-map";

const mocks = vi.hoisted(() => ({
  bootElizaRuntime: vi.fn(),
  startEliza: vi.fn(),
  repairRuntimeAfterBoot: vi.fn(),
  failRuntimeRepair: vi.fn(),
  startServerOnlyHost: vi.fn(),
  prepareLocalEmbeddingWarmup: vi.fn(),
}));

vi.mock("@elizaos/agent", async () => {
  const pluginTypes = await import("@elizaos/agent/runtime/plugin-types");
  const collector = await import("@elizaos/agent/runtime/plugin-collector");
  const runtimeEliza = await import("@elizaos/agent/runtime/eliza");
  return {
    CUSTOM_PLUGINS_DIRNAME: pluginTypes.CUSTOM_PLUGINS_DIRNAME,
    resolvePackageEntry: pluginTypes.resolvePackageEntry,
    scanDropInPlugins: pluginTypes.scanDropInPlugins,
    collectPluginNames: collector.collectPluginNames,
    applyCloudConfigToEnv: runtimeEliza.applyCloudConfigToEnv,
    bootElizaRuntime: mocks.bootElizaRuntime,
    startEliza: mocks.startEliza,
    getLastFailedPluginNames: () => [],
    loadElizaConfig: () => ({}),
    resolveDefaultAgentWorkspaceDir: () => "/tmp/app-core-eliza-workspace",
    resolveUserPath: (input: string) => input,
    shutdownRuntime: async () => {},
  };
});

vi.mock("./startup/app-runtime-host.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./startup/app-runtime-host.js")>();
  return {
    ...actual,
    repairRuntimeAfterBoot: mocks.repairRuntimeAfterBoot,
    failRuntimeRepair: mocks.failRuntimeRepair,
  };
});

vi.mock("./startup/server-only-host.js", () => ({
  startServerOnlyHost: mocks.startServerOnlyHost,
}));

vi.mock("./startup/local-model-warmup.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./startup/local-model-warmup.js")>();
  return {
    ...actual,
    prepareLocalEmbeddingWarmup: mocks.prepareLocalEmbeddingWarmup,
  };
});

import {
  applyCloudConfigToEnv,
  attemptPgliteAutoReset,
  bootElizaRuntime,
  CHANNEL_PLUGIN_MAP,
  CUSTOM_PLUGINS_DIRNAME,
  collectPluginNames,
  createRuntimeBootResources,
  drainBootHookContributors,
  drainRuntimeHookContributors,
  getDeferAppRoutesEnabled,
  getPgliteRecoveryRetrySkipPlugins,
  getSkippedAppRoutePluginIds,
  normalizeAppRoutePluginId,
  resolveBootHookContributors,
  resolvePackageEntry,
  scanDropInPlugins,
  startDeferredLocalEmbeddingWarmup,
  startEliza,
} from "./eliza";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_AGENT_ORCHESTRATOR",
  "ELIZA_PLUGIN_SET",
  "ELIZA_DEFAULT_AGENT_TYPE",
  "ELIZA_ACP_DEFAULT_AGENT",
  "ELIZA_AGENT_SELECTION_STRATEGY",
  "ELIZA_MAX_CONCURRENT_SPAWNS",
  "ELIZA_DISABLE_PERSONAL_ASSISTANT",
  "ELIZA_GITPATHOLOGIST",
  "ELIZA_WORKSPACE_DIR",
  "ELIZA_TELEGRAM_STANDALONE_BOT",
  "ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
  "LIFEOPS_PASSIVE_CONNECTORS",
  "ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZA_DEFER_APP_ROUTES",
  "ELIZA_SKIP_APP_ROUTE_PLUGINS",
  "ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP",
  "EMBEDDING_DIMENSION",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CEREBRAS_API_KEY",
  "OLLAMA_BASE_URL",
  "ZAI_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

function snapshotEnv(): void {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ELIZA_GITPATHOLOGIST = "0";
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function emptyConfig(): ElizaConfig {
  return {} as ElizaConfig;
}

function runtimeNamed(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

beforeEach(() => {
  snapshotEnv();
  _resetAgentHostBridge();
  mocks.bootElizaRuntime.mockReset();
  mocks.startEliza.mockReset();
  mocks.repairRuntimeAfterBoot.mockReset();
  mocks.failRuntimeRepair.mockReset();
  mocks.startServerOnlyHost.mockReset();
  mocks.prepareLocalEmbeddingWarmup.mockReset();
  mocks.repairRuntimeAfterBoot.mockImplementation(
    async (runtime: AgentRuntime) => runtime,
  );
  mocks.failRuntimeRepair.mockImplementation(
    async (_runtime: AgentRuntime, _scope: string, error: unknown) => {
      throw error;
    },
  );
  mocks.startServerOnlyHost.mockImplementation(
    async ({
      bootRuntime,
    }: {
      bootRuntime: (
        onPostReadyPhase: (phase: string) => void,
      ) => Promise<unknown>;
    }) => bootRuntime(() => {}),
  );
});

afterEach(() => {
  _resetAgentHostBridge();
  restoreEnv();
  vi.clearAllMocks();
});

describe("eliza.ts public re-exports", () => {
  it("re-exports CHANNEL_PLUGIN_MAP by identity and misses unknown names", () => {
    expect(CHANNEL_PLUGIN_MAP).toBe(sourceChannelPluginMap);
    expect(CHANNEL_PLUGIN_MAP.telegram).toBe("@elizaos/plugin-telegram");
    expect(CHANNEL_PLUGIN_MAP["not-a-channel"]).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP[""]).toBeUndefined();
    expect(CUSTOM_PLUGINS_DIRNAME).toBe("plugins/custom");
  });

  it("createRuntimeBootResources starts with an empty resource slot", () => {
    expect(createRuntimeBootResources()).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });
});

describe("scanDropInPlugins", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("app-core-eliza-dropin-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty record for a missing directory", async () => {
    await expect(
      scanDropInPlugins(path.join(root, "does-not-exist")),
    ).resolves.toEqual({});
  });

  it("returns an empty record for an empty directory", async () => {
    await expect(scanDropInPlugins(root)).resolves.toEqual({});
  });

  it("ignores files and records a single subdirectory without package.json", async () => {
    writeFileSync(path.join(root, "readme.txt"), "not a plugin");
    const pluginDir = path.join(root, "solo-plugin");
    mkdirSync(pluginDir);

    await expect(scanDropInPlugins(root)).resolves.toEqual({
      "solo-plugin": {
        source: "path",
        installPath: pluginDir,
        version: "0.0.0",
      },
    });
  });

  it("uses package.json name/version, and falls back when name is blank", async () => {
    const namedDir = path.join(root, "named");
    mkdirSync(namedDir);
    writeFileSync(
      path.join(namedDir, "package.json"),
      JSON.stringify({ name: " @elizaos/plugin-named ", version: " 2.1.0 " }),
    );
    const blankDir = path.join(root, "blank-name");
    mkdirSync(blankDir);
    writeFileSync(
      path.join(blankDir, "package.json"),
      JSON.stringify({ name: "   ", version: "9.9.9" }),
    );
    const invalidDir = path.join(root, "invalid-json");
    mkdirSync(invalidDir);
    writeFileSync(path.join(invalidDir, "package.json"), "{not json");

    const records = await scanDropInPlugins(root);
    expect(records["@elizaos/plugin-named"]).toEqual({
      source: "path",
      installPath: namedDir,
      version: "2.1.0",
    });
    expect(records["blank-name"]).toEqual({
      source: "path",
      installPath: blankDir,
      version: "9.9.9",
    });
    expect(records["invalid-json"]).toEqual({
      source: "path",
      installPath: invalidDir,
      version: "0.0.0",
    });
    expect(records.named).toBeUndefined();
  });
});

describe("resolvePackageEntry", () => {
  let pkgRoot: string;

  beforeEach(() => {
    pkgRoot = makeTempDir("app-core-eliza-pkg-");
  });

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it("falls back to dist/index when package.json and candidates are missing", async () => {
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(pkgRoot, "dist", "index"),
    );
  });

  it("prefers an existing fallback candidate over the missing dist/index", async () => {
    const indexTs = path.join(pkgRoot, "index.ts");
    writeFileSync(indexTs, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(indexTs),
    );
  });
});

describe("collectPluginNames", () => {
  it("seeds core plugins on a blank config; an empty allow-list is not exclusive", () => {
    const blank = collectPluginNames(emptyConfig());
    expect(blank.has("@elizaos/plugin-sql")).toBe(true);
    expect(blank.has("agent-orchestrator")).toBe(false);

    const emptyAllow = collectPluginNames({
      plugins: { allow: [] },
    } as ElizaConfig);
    expect(emptyAllow.has("@elizaos/plugin-sql")).toBe(true);
    expect(emptyAllow.size).toBeGreaterThan(0);
  });

  it("records the first winning reason and drops a disabled allow-listed plugin", () => {
    const reasons = new Map<string, string>();
    const names = collectPluginNames(
      {
        plugins: {
          allow: ["@elizaos/plugin-sql", "discord"],
          entries: {
            discord: { enabled: false },
          },
        },
      } as ElizaConfig,
      reasons,
    );

    expect(reasons.get("@elizaos/plugin-sql")).toBe("CORE_PLUGINS");
    expect(names.has("@elizaos/plugin-discord")).toBe(false);
    expect(reasons.get("@elizaos/plugin-discord")).toBe(
      'plugins.allow["discord"]',
    );
  });

  it("adds a single allow-listed channel plugin", () => {
    const names = collectPluginNames({
      plugins: { allow: ["discord"] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-discord")).toBe(true);
  });
});

describe("applyCloudConfigToEnv", () => {
  it("returns without writing inference flags when cloud is unset", () => {
    applyCloudConfigToEnv(emptyConfig());
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
  });

  it("forces cloud inference on for a provisioned container", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    applyCloudConfigToEnv(emptyConfig());
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
  });
});

describe("app-route skip / defer / normalize helpers", () => {
  it("getDeferAppRoutesEnabled defers by default; only explicit falsy tokens opt out", () => {
    expect(getDeferAppRoutesEnabled({})).toBe(true);
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "1" })).toBe(
      true,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "0" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "false" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "NO" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: " off " })).toBe(
      false,
    );
  });

  it("getSkippedAppRoutePluginIds treats unset/blank as empty and drops blank segments", () => {
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
    process.env.ELIZA_SKIP_APP_ROUTE_PLUGINS = "   ";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
    process.env.ELIZA_SKIP_APP_ROUTE_PLUGINS = "lifeops,, training,";
    expect(getSkippedAppRoutePluginIds()).toEqual(
      new Set(["lifeops", "training"]),
    );
  });

  it("normalizeAppRoutePluginId strips prefix/suffix and is idempotent on short aliases", () => {
    expect(normalizeAppRoutePluginId("")).toBe("");
    expect(normalizeAppRoutePluginId("  @elizaos/plugin-wallet:ui  ")).toBe(
      "wallet",
    );
    expect(normalizeAppRoutePluginId("wallet")).toBe("wallet");
    expect(normalizeAppRoutePluginId("Hyperliquid-App")).toBe("hyperliquid");
  });
});

describe("drain contributors", () => {
  it("no-ops on an empty boot-hook queue and invokes a single contributor", async () => {
    const runtime = runtimeNamed("hooks");
    await expect(
      drainBootHookContributors(runtime, []),
    ).resolves.toBeUndefined();

    const invoke = vi.fn().mockResolvedValue(undefined);
    await drainBootHookContributors(runtime, [{ id: "only", invoke }]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("invokes boot-hook contributors in declared order and stops after a throw", async () => {
    const runtime = runtimeNamed("hooks");
    const order: string[] = [];
    const failure = new Error("hook boom");
    const later = vi.fn();

    await expect(
      drainBootHookContributors(runtime, [
        {
          id: "a",
          invoke: async () => {
            order.push("a");
          },
        },
        {
          id: "b",
          invoke: async () => {
            order.push("b");
            throw failure;
          },
        },
        { id: "c", invoke: later },
      ]),
    ).rejects.toBe(failure);
    expect(order).toEqual(["a", "b"]);
    expect(later).not.toHaveBeenCalled();
  });

  it("resolveBootHookContributors keeps the first id on a tie and still includes the fallback", () => {
    const empty = resolveBootHookContributors([]);
    expect(
      empty.some((entry) => entry.id === "@elizaos/plugin-local-inference"),
    ).toBe(true);

    const tied = resolveBootHookContributors([
      {
        id: "@elizaos/plugin-local-inference",
        specifier: "./winner.js",
        exportName: "first",
      },
      {
        id: "@elizaos/plugin-local-inference",
        specifier: "./loser.js",
        exportName: "second",
      },
    ]);
    const match = tied.filter(
      (entry) => entry.id === "@elizaos/plugin-local-inference",
    );
    expect(match).toHaveLength(1);
    expect(match[0]?.invoke).toEqual(expect.any(Function));
  });

  it("drainRuntimeHookContributors no-ops on empty and preserves order until a real failure", async () => {
    const runtime = runtimeNamed("runtime-hooks");
    await expect(
      drainRuntimeHookContributors(runtime, []),
    ).resolves.toBeUndefined();

    const order: string[] = [];
    const failure = new Error("runtime hook boom");
    const later = vi.fn();
    await expect(
      drainRuntimeHookContributors(runtime, [
        {
          id: "a",
          invoke: async () => {
            order.push("a");
          },
        },
        {
          id: "b",
          invoke: async () => {
            order.push("b");
            throw failure;
          },
        },
        { id: "c", invoke: later },
      ]),
    ).rejects.toBe(failure);
    expect(order).toEqual(["a", "b"]);
    expect(later).not.toHaveBeenCalled();
  });
});

describe("pglite recovery re-exports and embedding deferral", () => {
  it("attemptPgliteAutoReset returns null for a non-pglite error", async () => {
    await expect(
      attemptPgliteAutoReset(new Error("not pglite")),
    ).resolves.toBeNull();
  });

  it("getPgliteRecoveryRetrySkipPlugins returns the last-failed plugin list", () => {
    expect(getPgliteRecoveryRetrySkipPlugins()).toEqual([]);
  });

  it("startDeferredLocalEmbeddingWarmup returns false when deferral is disabled", () => {
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "0";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(false);
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "false";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(false);
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "no";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(false);
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "off";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(false);
  });
});

describe("bootElizaRuntime", () => {
  it("defaults embedding width to 384, forwards progress, and returns the repaired runtime", async () => {
    const upstream = runtimeNamed("upstream-boot");
    const repaired = runtimeNamed("repaired-boot");
    const onEmbeddingProgress = vi.fn();
    mocks.bootElizaRuntime.mockResolvedValue(upstream);
    mocks.repairRuntimeAfterBoot.mockResolvedValue(repaired);

    const result = await bootElizaRuntime({ onEmbeddingProgress });

    expect(result).toBe(repaired);
    expect(result).not.toBe(upstream);
    expect(process.env.EMBEDDING_DIMENSION).toBe("384");
    expect(mocks.prepareLocalEmbeddingWarmup).toHaveBeenCalledExactlyOnceWith(
      onEmbeddingProgress,
    );
    expect(mocks.bootElizaRuntime).toHaveBeenCalledExactlyOnceWith({
      onEmbeddingProgress,
    });
    expect(mocks.repairRuntimeAfterBoot).toHaveBeenCalledOnce();
    expect(mocks.repairRuntimeAfterBoot.mock.calls[0]?.[0]).toBe(upstream);
    expect(mocks.failRuntimeRepair).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit EMBEDDING_DIMENSION", async () => {
    process.env.EMBEDDING_DIMENSION = "768";
    mocks.bootElizaRuntime.mockResolvedValue(runtimeNamed("boot"));
    await bootElizaRuntime();
    expect(process.env.EMBEDDING_DIMENSION).toBe("768");
  });

  it("skips repair and returns a falsy upstream runtime as-is", async () => {
    mocks.bootElizaRuntime.mockResolvedValueOnce(null);
    await expect(bootElizaRuntime()).resolves.toBeNull();
    expect(mocks.repairRuntimeAfterBoot).not.toHaveBeenCalled();

    mocks.bootElizaRuntime.mockResolvedValueOnce(undefined);
    await expect(bootElizaRuntime()).resolves.toBeUndefined();
    expect(mocks.repairRuntimeAfterBoot).not.toHaveBeenCalled();
  });

  it("routes a repair failure through failRuntimeRepair with scope boot", async () => {
    const upstream = runtimeNamed("boot-fail");
    const repairError = new Error("repair boom");
    const wrapped = new Error("wrapped boot repair");
    mocks.bootElizaRuntime.mockResolvedValue(upstream);
    mocks.repairRuntimeAfterBoot.mockRejectedValue(repairError);
    mocks.failRuntimeRepair.mockRejectedValue(wrapped);

    await expect(bootElizaRuntime()).rejects.toBe(wrapped);
    expect(mocks.failRuntimeRepair).toHaveBeenCalledExactlyOnceWith(
      upstream,
      "boot",
      repairError,
    );
  });
});

describe("startEliza", () => {
  it("defaults the orchestrator on when unset or a non-skip token, including off/yes", async () => {
    mocks.startEliza.mockResolvedValue(runtimeNamed("orch"));

    await startEliza();
    expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBe("1");
    expect(mocks.prepareLocalEmbeddingWarmup).toHaveBeenCalledExactlyOnceWith(
      undefined,
    );

    process.env.ELIZA_AGENT_ORCHESTRATOR = "yes";
    await startEliza();
    expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBe("1");

    process.env.ELIZA_AGENT_ORCHESTRATOR = "off";
    await startEliza();
    expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBe("1");
  });

  it.each(["0", "false", "no", "FALSE", " No "] as const)(
    "leaves ELIZA_AGENT_ORCHESTRATOR=%s untouched",
    async (raw) => {
      process.env.ELIZA_AGENT_ORCHESTRATOR = raw;
      mocks.startEliza.mockResolvedValue(runtimeNamed("orch-off"));
      await startEliza();
      expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBe(raw);
    },
  );

  it("installs the host bridge, returns the repaired runtime, and uses scope start on repair failure", async () => {
    const upstream = runtimeNamed("start-up");
    const repaired = runtimeNamed("start-repaired");
    mocks.startEliza.mockResolvedValue(upstream);
    mocks.repairRuntimeAfterBoot.mockResolvedValue(repaired);

    expect(getAgentHostBridge()).toBe(defaultAgentHostBridge);
    const result = await startEliza({ headless: true });
    expect(result).toBe(repaired);
    expect(getAgentHostBridge()).not.toBe(defaultAgentHostBridge);
    expect(mocks.startEliza).toHaveBeenCalledExactlyOnceWith({
      headless: true,
    });
    expect(mocks.startServerOnlyHost).not.toHaveBeenCalled();

    const repairError = new Error("start repair boom");
    const wrapped = new Error("wrapped start repair");
    mocks.repairRuntimeAfterBoot.mockRejectedValue(repairError);
    mocks.failRuntimeRepair.mockRejectedValue(wrapped);
    await expect(startEliza()).rejects.toBe(wrapped);
    expect(mocks.failRuntimeRepair).toHaveBeenCalledWith(
      upstream,
      "start",
      repairError,
    );
  });

  it("returns a null upstream runtime without repairing it", async () => {
    mocks.startEliza.mockResolvedValue(null);
    await expect(startEliza()).resolves.toBeNull();
    expect(mocks.repairRuntimeAfterBoot).not.toHaveBeenCalled();
  });

  it("rethrows a generic startup error as-is and wraps a legacy PGlite abort", async () => {
    const generic = new Error("not a database problem");
    mocks.startEliza.mockRejectedValueOnce(generic);
    await expect(startEliza()).rejects.toBe(generic);

    const abort = new Error("wasm aborted()");
    mocks.startEliza.mockRejectedValueOnce(abort);
    try {
      await startEliza();
      expect.unreachable("legacy PGlite abort should be wrapped");
    } catch (error) {
      expect(error).not.toBe(abort);
      expect(error).toBeInstanceOf(Error);
      const wrapped = error as Error & { code?: string; cause?: unknown };
      expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
      expect(wrapped.cause).toBe(abort);
      expect(wrapped.message).toMatch(/PGlite initialization failed/);
    }

    const alreadyCoded = new Error("already coded") as Error & { code: string };
    alreadyCoded.code = PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED;
    mocks.startEliza.mockRejectedValueOnce(alreadyCoded);
    await expect(startEliza()).rejects.toBe(alreadyCoded);
  });

  it("server-only boot forces headless, converts null to undefined, and uses server-only-boot on repair failure", async () => {
    const onServerOnlyHostReady = vi.fn();
    const upstream = runtimeNamed("server-up");
    const repaired = runtimeNamed("server-repaired");
    mocks.startEliza.mockResolvedValue(upstream);
    mocks.repairRuntimeAfterBoot.mockResolvedValue(repaired);

    const result = await startEliza({
      serverOnly: true,
      localAgentMode: true,
      onServerOnlyHostReady,
    });
    expect(result).toBe(repaired);
    expect(mocks.startServerOnlyHost).toHaveBeenCalledOnce();
    const hostArgs = mocks.startServerOnlyHost.mock.calls[0]?.[0] as {
      options: {
        serverOnly: boolean;
        localAgentMode: boolean;
        onServerOnlyHostReady: typeof onServerOnlyHostReady;
      };
      stopRuntime: unknown;
      stopWithoutRuntime: unknown;
    };
    expect(hostArgs.options.serverOnly).toBe(true);
    expect(hostArgs.options.localAgentMode).toBe(true);
    expect(hostArgs.options.onServerOnlyHostReady).toBe(onServerOnlyHostReady);
    expect(typeof hostArgs.stopRuntime).toBe("function");
    expect(typeof hostArgs.stopWithoutRuntime).toBe("function");
    expect(mocks.startEliza).toHaveBeenCalledWith({
      serverOnly: false,
      localAgentMode: true,
      onServerOnlyHostReady,
      headless: true,
    });
    expect(mocks.repairRuntimeAfterBoot.mock.calls[0]?.[2]).toEqual(
      expect.any(Function),
    );

    mocks.startEliza.mockResolvedValueOnce(null);
    mocks.repairRuntimeAfterBoot.mockClear();
    await expect(startEliza({ serverOnly: true })).resolves.toBeUndefined();
    expect(mocks.repairRuntimeAfterBoot).not.toHaveBeenCalled();

    const repairError = new Error("server repair boom");
    const wrapped = new Error("wrapped server repair");
    mocks.startEliza.mockResolvedValue(upstream);
    mocks.repairRuntimeAfterBoot.mockRejectedValue(repairError);
    mocks.failRuntimeRepair.mockRejectedValue(wrapped);
    await expect(startEliza({ serverOnly: true })).rejects.toBe(wrapped);
    expect(mocks.failRuntimeRepair).toHaveBeenCalledWith(
      upstream,
      "server-only-boot",
      repairError,
    );
  });
});
