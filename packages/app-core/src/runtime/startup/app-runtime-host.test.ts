/**
 * Colocated coverage for the app-runtime host that repairs a runtime after
 * the agent boots: mobile skip, deferred vs inline post-ready tail, trigger
 * and catalog resource lifecycle, shutdown, and repair-failure wrapping.
 * Plugin loaders and the upstream shutdown path are stubbed so the suite does
 * not boot a live runtime; every assertion is about this module's control
 * flow and observable host state.
 */
import type { AgentRuntime } from "@elizaos/core";
import {
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  ElizaError,
  logger,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRuntimeSqlCompatibility: vi.fn(async () => {}),
  configureAutonomy: vi.fn(async () => {}),
  markDeferredBootPhase: vi.fn(),
  isMobilePlatform: vi.fn((env: NodeJS.ProcessEnv = process.env) => {
    const raw = env.ELIZA_PLATFORM?.trim().toLowerCase();
    return raw === "android" || raw === "ios";
  }),
  getDeferAppRoutesEnabled: vi.fn((env: NodeJS.ProcessEnv = process.env) => {
    const raw = env.ELIZA_DEFER_APP_ROUTES?.trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  }),
  registerAppRoutePlugins: vi.fn(async () => {}),
  registerRuntimeHooks: vi.fn(async () => {}),
  registerCoreSensitiveRequestAdapters: vi.fn(),
  registerSubAgentCredentialBridge: vi.fn(async () => {}),
  registerSubAgentCredentialBridgeAdapter: vi.fn(() => true),
  startDeferredVoiceWarmup: vi.fn(),
  startTriggerEventBridge: vi.fn(() => ({ stop: vi.fn() })),
  createElizaConnectorTargetCatalog: vi.fn(
    (_options: { getConfig: () => unknown; listSources: () => unknown[] }) => ({
      id: "catalog",
    }),
  ),
  loadElizaConfig: vi.fn(() => ({ name: "cfg" })),
  upstreamShutdownRuntime: vi.fn(async () => "upstream-stopped"),
}));

vi.mock("@elizaos/shared", () => ({
  ensureRuntimeSqlCompatibility: mocks.ensureRuntimeSqlCompatibility,
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  formatErrorWithStack: (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  isMobilePlatform: mocks.isMobilePlatform,
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: mocks.loadElizaConfig,
  shutdownRuntime: mocks.upstreamShutdownRuntime,
}));

vi.mock("@elizaos/agent/runtime/deferred-boot-status", () => ({
  markDeferredBootPhase: mocks.markDeferredBootPhase,
}));

vi.mock("./autonomy.js", () => ({
  configureAutonomy: mocks.configureAutonomy,
}));

vi.mock("./app-contributors.js", () => ({
  getDeferAppRoutesEnabled: mocks.getDeferAppRoutesEnabled,
  registerAppRoutePlugins: mocks.registerAppRoutePlugins,
  registerRuntimeHooks: mocks.registerRuntimeHooks,
}));

vi.mock("./local-model-warmup.js", () => ({
  startDeferredVoiceWarmup: mocks.startDeferredVoiceWarmup,
}));

vi.mock("../../services/sensitive-requests/index.js", () => ({
  registerCoreSensitiveRequestAdapters:
    mocks.registerCoreSensitiveRequestAdapters,
}));

vi.mock("../sub-agent-credential-bridge-wiring.js", () => ({
  registerSubAgentCredentialBridge: mocks.registerSubAgentCredentialBridge,
}));

vi.mock("../../services/credential-tunnel-service", () => ({
  registerSubAgentCredentialBridgeAdapter:
    mocks.registerSubAgentCredentialBridgeAdapter,
}));

vi.mock("../../services/trigger-event-bridge.js", () => ({
  startTriggerEventBridge: mocks.startTriggerEventBridge,
}));

vi.mock("../../services/connector-target-catalog.js", () => ({
  createElizaConnectorTargetCatalog: mocks.createElizaConnectorTargetCatalog,
}));

import * as host from "./app-runtime-host.ts";
import {
  createRuntimeBootResources,
  failRuntimeRepair,
  repairRuntimeAfterBoot,
  runPostReadyBootTail,
  shutdownRuntime,
  stopRuntimeBootResources,
} from "./app-runtime-host.ts";
import * as postReady from "./post-ready.ts";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_DEFER_APP_ROUTES",
  "ENABLE_AUTONOMY",
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const snapshot = {} as EnvSnapshot;
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function makeRuntime(): AgentRuntime {
  const services = new Map<string, unknown[]>();
  return {
    agentId: "agent-id",
    services,
    getService: (type: string) => services.get(type)?.[0] ?? null,
    reportError: vi.fn(),
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

async function waitForTailArmed(): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.startDeferredVoiceWarmup).toHaveBeenCalled();
  });
}

describe("app-runtime-host exports", () => {
  it("re-exports the post-ready resource factory and tail by identity", () => {
    expect(Object.keys(host).sort()).toEqual([
      "createRuntimeBootResources",
      "failRuntimeRepair",
      "repairRuntimeAfterBoot",
      "runPostReadyBootTail",
      "shutdownRuntime",
      "stopRuntimeBootResources",
    ]);
    expect(createRuntimeBootResources).toBe(
      postReady.createRuntimeBootResources,
    );
    expect(runPostReadyBootTail).toBe(postReady.runPostReadyBootTail);
  });

  it("createRuntimeBootResources returns an empty ownership slot", () => {
    expect(createRuntimeBootResources()).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });
});

describe("repairRuntimeAfterBoot", () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    mocks.ensureRuntimeSqlCompatibility
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.configureAutonomy.mockReset().mockResolvedValue(undefined);
    mocks.markDeferredBootPhase.mockReset();
    mocks.registerAppRoutePlugins.mockReset().mockResolvedValue(undefined);
    mocks.registerRuntimeHooks.mockReset().mockResolvedValue(undefined);
    mocks.registerCoreSensitiveRequestAdapters.mockReset();
    mocks.registerSubAgentCredentialBridge
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.registerSubAgentCredentialBridgeAdapter
      .mockReset()
      .mockReturnValue(true);
    mocks.startDeferredVoiceWarmup.mockReset();
    mocks.startTriggerEventBridge.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    mocks.createElizaConnectorTargetCatalog
      .mockReset()
      .mockReturnValue({ id: "catalog" });
    mocks.loadElizaConfig.mockReset().mockReturnValue({ name: "cfg" });
    mocks.upstreamShutdownRuntime
      .mockReset()
      .mockResolvedValue("upstream-stopped");
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
  });

  it("on mobile skips desktop helpers, marks the tail complete, and still runs SQL compat", async () => {
    process.env.ELIZA_PLATFORM = "android";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    const phases: Array<"pending" | "complete" | "failed"> = [];

    const result = await repairRuntimeAfterBoot(runtime, resources, (phase) => {
      phases.push(phase);
    });

    expect(result).toBe(runtime);
    expect(phases).toEqual(["complete"]);
    expect(mocks.ensureRuntimeSqlCompatibility).toHaveBeenCalledExactlyOnceWith(
      runtime,
    );
    expect(mocks.configureAutonomy).not.toHaveBeenCalled();
    expect(mocks.registerAppRoutePlugins).not.toHaveBeenCalled();
    expect(mocks.startTriggerEventBridge).not.toHaveBeenCalled();
    expect(mocks.markDeferredBootPhase).toHaveBeenCalledExactlyOnceWith(
      "app-route-tail",
      "complete",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[eliza] Mobile platform detected — skipping desktop-only boot helpers",
    );
    expect(resources.tailRuntime).toBeNull();
  });

  it("treats ios as mobile and an unknown platform as desktop", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    await repairRuntimeAfterBoot(makeRuntime(), createRuntimeBootResources());
    expect(mocks.configureAutonomy).not.toHaveBeenCalled();

    process.env.ELIZA_PLATFORM = "linux";
    await repairRuntimeAfterBoot(makeRuntime(), createRuntimeBootResources());
    await waitForTailArmed();
    expect(mocks.configureAutonomy).toHaveBeenCalledOnce();
  });

  it("passes the observed ENABLE_AUTONOMY parsing into configureAutonomy", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();

    await repairRuntimeAfterBoot(runtime, resources);
    expect(mocks.configureAutonomy).toHaveBeenLastCalledWith(runtime, false);

    process.env.ENABLE_AUTONOMY = "true";
    await repairRuntimeAfterBoot(runtime, resources);
    expect(mocks.configureAutonomy).toHaveBeenLastCalledWith(runtime, true);

    process.env.ENABLE_AUTONOMY = "1";
    await repairRuntimeAfterBoot(runtime, resources);
    expect(mocks.configureAutonomy).toHaveBeenLastCalledWith(runtime, true);

    process.env.ENABLE_AUTONOMY = "yes";
    await repairRuntimeAfterBoot(runtime, resources);
    expect(mocks.configureAutonomy).toHaveBeenLastCalledWith(runtime, false);
  });

  it("returns before a hung deferred tail settles and reports pending then complete", async () => {
    let releaseRoutes: (() => void) | undefined;
    mocks.registerAppRoutePlugins.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRoutes = resolve;
        }),
    );
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    const phases: Array<"pending" | "complete" | "failed"> = [];

    const result = await repairRuntimeAfterBoot(runtime, resources, (phase) => {
      phases.push(phase);
    });

    expect(result).toBe(runtime);
    expect(phases).toEqual(["pending"]);
    expect(resources.tailRuntime).toBe(runtime);
    expect(mocks.markDeferredBootPhase).toHaveBeenCalledExactlyOnceWith(
      "app-route-tail",
      "pending",
    );
    expect(mocks.startTriggerEventBridge).not.toHaveBeenCalled();

    releaseRoutes?.();
    await waitForTailArmed();
    await vi.waitFor(() => {
      expect(phases).toEqual(["pending", "complete"]);
    });
  });

  it("isolates a deferred tail failure: repair resolves, phase fails, error is reported", async () => {
    const tailError = new Error("tail boom");
    mocks.registerAppRoutePlugins.mockRejectedValueOnce(tailError);
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    const phases: Array<"pending" | "complete" | "failed"> = [];

    await expect(
      repairRuntimeAfterBoot(runtime, resources, (phase) => {
        phases.push(phase);
      }),
    ).resolves.toBe(runtime);

    await vi.waitFor(() => {
      expect(phases).toEqual(["pending", "failed"]);
    });
    expect(mocks.markDeferredBootPhase).toHaveBeenCalledWith(
      "app-route-tail",
      "failed",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[eliza] post-ready boot tail failed:"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("tail boom"),
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "eliza.postReadyBootTail",
      tailError,
      { phase: "app-route-tail" },
    );
  });

  it("awaits the inline tail before returning so ready does not flip early", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    let releaseRoutes: (() => void) | undefined;
    mocks.registerAppRoutePlugins.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRoutes = resolve;
        }),
    );
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    let settled = false;
    const phases: Array<"pending" | "complete" | "failed"> = [];

    const pending = repairRuntimeAfterBoot(runtime, resources, (phase) => {
      phases.push(phase);
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => {
      expect(phases).toEqual(["pending"]);
    });
    expect(settled).toBe(false);
    expect(mocks.startTriggerEventBridge).not.toHaveBeenCalled();

    releaseRoutes?.();
    await expect(pending).resolves.toBe(runtime);
    expect(settled).toBe(true);
    expect(phases).toEqual(["pending", "complete"]);
  });

  it("marks the inline tail failed and rethrows the original error", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const inlineError = new Error("inline boom");
    mocks.registerAppRoutePlugins.mockRejectedValueOnce(inlineError);
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    const phases: Array<"pending" | "complete" | "failed"> = [];

    await expect(
      repairRuntimeAfterBoot(runtime, resources, (phase) => {
        phases.push(phase);
      }),
    ).rejects.toBe(inlineError);

    expect(phases).toEqual(["pending", "failed"]);
    expect(mocks.markDeferredBootPhase).toHaveBeenCalledWith(
      "app-route-tail",
      "failed",
    );
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("runs SQL compat before autonomy before the first tail contributor", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const order: string[] = [];
    mocks.ensureRuntimeSqlCompatibility.mockImplementation(async () => {
      order.push("sql");
    });
    mocks.configureAutonomy.mockImplementation(async () => {
      order.push("autonomy");
    });
    mocks.registerAppRoutePlugins.mockImplementation(async () => {
      order.push("routes");
    });

    await repairRuntimeAfterBoot(makeRuntime(), createRuntimeBootResources());

    expect(order).toEqual(["sql", "autonomy", "routes"]);
  });

  it("arms a trigger bridge and replaces a live one by stopping the previous handle", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();

    await repairRuntimeAfterBoot(runtime, resources);
    expect(mocks.startTriggerEventBridge).toHaveBeenCalledExactlyOnceWith(
      runtime,
    );
    const firstHandle = resources.triggerEventBridge;
    expect(firstHandle).toBeTruthy();

    await repairRuntimeAfterBoot(runtime, resources);
    expect(firstHandle?.stop).toHaveBeenCalledOnce();
    expect(resources.triggerEventBridge).not.toBe(firstHandle);
    expect(mocks.startTriggerEventBridge).toHaveBeenCalledTimes(2);
  });

  it("registers a connector catalog from an empty source list when no registry exists", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();

    await repairRuntimeAfterBoot(runtime, resources);

    expect(mocks.createElizaConnectorTargetCatalog).toHaveBeenCalledOnce();
    const options = mocks.createElizaConnectorTargetCatalog.mock.calls[0][0];
    expect(options.listSources()).toEqual([]);
    expect(options.getConfig()).toEqual({ name: "cfg" });
    expect(mocks.loadElizaConfig).toHaveBeenCalledOnce();
    expect(runtime.services.get("connector_target_catalog" as never)).toEqual([
      { id: "catalog" },
    ]);
    expect(resources.connectorTargetCatalog).toBeTruthy();
  });

  it("drains the connector source registry when one is installed", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const sources = [{ id: "discord" }];
    runtime.services.set(
      CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE as never,
      [{ list: () => sources }] as never,
    );
    const resources = createRuntimeBootResources();

    await repairRuntimeAfterBoot(runtime, resources);

    const options = mocks.createElizaConnectorTargetCatalog.mock.calls[0][0];
    expect(options.listSources()).toBe(sources);
  });

  it("catalog stop deletes the registered service and a second repair stops the previous catalog", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();

    await repairRuntimeAfterBoot(runtime, resources);
    if (!resources.connectorTargetCatalog) {
      throw new Error("expected catalog after first repair");
    }
    const originalStop = resources.connectorTargetCatalog.stop;
    const firstStop = vi.fn(originalStop);
    resources.connectorTargetCatalog.stop = firstStop;

    await repairRuntimeAfterBoot(runtime, resources);
    expect(firstStop).toHaveBeenCalledOnce();
    expect(runtime.services.get("connector_target_catalog" as never)).toEqual([
      { id: "catalog" },
    ]);

    resources.connectorTargetCatalog?.stop();
    expect(
      runtime.services.get("connector_target_catalog" as never),
    ).toBeUndefined();
  });

  it("is a no-op callback when onPostReadyPhase is omitted", async () => {
    process.env.ELIZA_PLATFORM = "android";
    await expect(
      repairRuntimeAfterBoot(makeRuntime(), createRuntimeBootResources()),
    ).resolves.toBeTruthy();
  });
});

describe("stopRuntimeBootResources", () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
  });

  it("clears an empty ownership slot without calling missing stop handles", () => {
    const resources = createRuntimeBootResources();
    resources.tailRuntime = makeRuntime();

    stopRuntimeBootResources(resources);

    expect(resources).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });

  it("stops a single live bridge and leaves a missing catalog untouched", () => {
    const stop = vi.fn();
    const resources = createRuntimeBootResources();
    resources.triggerEventBridge = { stop };

    stopRuntimeBootResources(resources);

    expect(stop).toHaveBeenCalledOnce();
    expect(resources.triggerEventBridge).toBeNull();
    expect(resources.connectorTargetCatalog).toBeNull();
  });

  it("stops both resources and continues after a throwing bridge stop", () => {
    const catalogStop = vi.fn();
    const resources = createRuntimeBootResources();
    resources.triggerEventBridge = {
      stop: () => {
        throw new Error("bridge stop failed");
      },
    };
    resources.connectorTargetCatalog = { stop: catalogStop };

    stopRuntimeBootResources(resources);

    expect(catalogStop).toHaveBeenCalledOnce();
    expect(resources.triggerEventBridge).toBeNull();
    expect(resources.connectorTargetCatalog).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[eliza] Trigger event bridge stop failed during shutdown:",
      ),
    );
  });

  it("warns and still clears the slot when catalog stop throws", () => {
    const resources = createRuntimeBootResources();
    resources.connectorTargetCatalog = {
      stop: () => {
        throw new Error("catalog stop failed");
      },
    };

    stopRuntimeBootResources(resources);

    expect(resources.connectorTargetCatalog).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[eliza] Connector target catalog stop failed during shutdown:",
      ),
    );
  });
});

describe("shutdownRuntime", () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    mocks.ensureRuntimeSqlCompatibility
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.configureAutonomy.mockReset().mockResolvedValue(undefined);
    mocks.markDeferredBootPhase.mockReset();
    mocks.registerAppRoutePlugins.mockReset().mockResolvedValue(undefined);
    mocks.registerRuntimeHooks.mockReset().mockResolvedValue(undefined);
    mocks.registerCoreSensitiveRequestAdapters.mockReset();
    mocks.registerSubAgentCredentialBridge
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.registerSubAgentCredentialBridgeAdapter
      .mockReset()
      .mockReturnValue(true);
    mocks.startDeferredVoiceWarmup.mockReset();
    mocks.startTriggerEventBridge.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    mocks.createElizaConnectorTargetCatalog
      .mockReset()
      .mockReturnValue({ id: "catalog" });
    mocks.upstreamShutdownRuntime
      .mockReset()
      .mockResolvedValue("upstream-stopped");
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
  });

  it("forwards a missing runtime to upstream shutdown with no resource stop", async () => {
    await expect(shutdownRuntime(undefined, "no runtime")).resolves.toBe(
      "upstream-stopped",
    );
    expect(mocks.upstreamShutdownRuntime).toHaveBeenCalledExactlyOnceWith(
      undefined,
      "no runtime",
    );
  });

  it("skips resource stop when the runtime was never repaired", async () => {
    const runtime = makeRuntime();
    const stop = vi.fn();
    const orphan = createRuntimeBootResources();
    orphan.triggerEventBridge = { stop };

    await shutdownRuntime(runtime, "never repaired");

    expect(stop).not.toHaveBeenCalled();
    expect(mocks.upstreamShutdownRuntime).toHaveBeenCalledExactlyOnceWith(
      runtime,
      "never repaired",
    );
  });

  it("stops mapped boot resources then forgets them on a second shutdown", async () => {
    process.env.ELIZA_DEFER_APP_ROUTES = "0";
    const runtime = makeRuntime();
    const resources = createRuntimeBootResources();
    await repairRuntimeAfterBoot(runtime, resources);
    const bridgeStop = resources.triggerEventBridge?.stop;
    expect(bridgeStop).toEqual(expect.any(Function));

    await expect(shutdownRuntime(runtime, "repair done")).resolves.toBe(
      "upstream-stopped",
    );
    expect(bridgeStop).toHaveBeenCalledOnce();
    expect(resources.triggerEventBridge).toBeNull();
    expect(resources.tailRuntime).toBeNull();

    await shutdownRuntime(runtime, "second close");
    expect(bridgeStop).toHaveBeenCalledOnce();
    expect(mocks.upstreamShutdownRuntime).toHaveBeenCalledTimes(2);
  });
});

describe("failRuntimeRepair", () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    mocks.upstreamShutdownRuntime
      .mockReset()
      .mockResolvedValue("upstream-stopped");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
  });

  it("wraps a successful cleanup as APP_RUNTIME_REPAIR_FAILED for every scope", async () => {
    const repairError = new Error("sql compat failed");
    const runtime = makeRuntime();

    for (const scope of ["boot", "server-only-boot", "start"] as const) {
      mocks.upstreamShutdownRuntime.mockClear();
      const rejection = await failRuntimeRepair(
        runtime,
        scope,
        repairError,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(ElizaError);
      expect(rejection).toMatchObject({
        code: "APP_RUNTIME_REPAIR_FAILED",
        cause: repairError,
        context: { scope },
        severity: "fatal",
      });
      expect((rejection as Error).message).toBe(
        "App-core runtime repair failed",
      );
      expect(mocks.upstreamShutdownRuntime).toHaveBeenCalledExactlyOnceWith(
        runtime,
        `${scope} repair failed`,
      );
    }
  });

  it("aggregates repair and shutdown failures instead of hiding either cause", async () => {
    const repairError = new Error("repair exploded");
    const shutdownError = new Error("shutdown exploded");
    mocks.upstreamShutdownRuntime.mockRejectedValueOnce(shutdownError);
    const runtime = makeRuntime();

    const rejection = await failRuntimeRepair(
      runtime,
      "boot",
      repairError,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ElizaError);
    expect(rejection).toMatchObject({
      code: "APP_RUNTIME_REPAIR_CLEANUP_FAILED",
      context: { scope: "boot" },
      severity: "fatal",
    });
    expect((rejection as Error).message).toBe(
      "Runtime repair and cleanup failed",
    );
    const cause = (rejection as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([
      repairError,
      shutdownError,
    ]);
  });
});
