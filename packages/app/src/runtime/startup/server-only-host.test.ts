/**
 * Colocated coverage for the server-only bind-first host. Drives the real
 * `startServerOnlyHost` orchestrator: port selection, IPC skip-listen, API-bind
 * failure, deferred onboarding, immediate boot success/empty/throw, post-ready
 * phase mapping, restart, sandbox register/heartbeat/teardown, and idempotent
 * close. Socket bind, first-run disk, and Redis are stubbed as I/O seams;
 * assertions observe host sequencing and projected startup state, not mock echo.
 */
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as serverOnlyHostModule from "./server-only-host.ts";
import {
  type StartServerOnlyHostOptions,
  startServerOnlyHost,
} from "./server-only-host.ts";

const mocks = vi.hoisted(() => {
  let pendingBoot: (() => Promise<void>) | null = null;
  return {
    startApiServer: vi.fn(),
    shouldDefer: vi.fn(() => false),
    buildSandboxRegistryFromEnv: vi.fn((): unknown => null),
    invalidateCorsAllowedPorts: vi.fn(),
    registerDeferredRuntimeBoot: vi.fn((boot: () => Promise<void>) => {
      pendingBoot = boot;
    }),
    isRuntimeBootDeferred: vi.fn(() => pendingBoot !== null),
    triggerDeferredRuntimeBoot: vi.fn(async (_reason: string) => {
      const boot = pendingBoot;
      if (!boot) return;
      await boot();
      pendingBoot = null;
    }),
    resetDeferred() {
      pendingBoot = null;
    },
  };
});

vi.mock("../../api/server.js", () => ({
  startApiServer: (...args: unknown[]) => mocks.startApiServer(...args),
}));

vi.mock("../../api/deferred-runtime-boot.js", () => ({
  shouldDeferRuntimeBootUntilOnboarding: () => mocks.shouldDefer(),
  registerDeferredRuntimeBoot: (boot: () => Promise<void>) =>
    mocks.registerDeferredRuntimeBoot(boot),
  isRuntimeBootDeferred: () => mocks.isRuntimeBootDeferred(),
  triggerDeferredRuntimeBoot: (reason: string) =>
    mocks.triggerDeferredRuntimeBoot(reason),
}));

vi.mock("../../api/server-cors.js", () => ({
  invalidateCorsAllowedPorts: () => mocks.invalidateCorsAllowedPorts(),
}));

vi.mock("@elizaos/shared/sandbox-registry", () => ({
  buildSandboxRegistryFromEnv: () => mocks.buildSandboxRegistryFromEnv(),
}));

type PostReadyPhase = "pending" | "complete" | "failed";

type StartupUpdate = {
  phase: string;
  attempt: number;
  state: string;
};

type ApiHandle = {
  port: number;
  updateRuntime: ReturnType<typeof vi.fn<(runtime: AgentRuntime) => void>>;
  updateStartup: ReturnType<typeof vi.fn<(update: StartupUpdate) => void>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

type StartApiServerOpts = {
  port: number;
  skipListen?: boolean;
  initialAgentState?: string;
  onRestart: () => Promise<AgentRuntime | null>;
};

const ENV_KEYS = [
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_UI_PORT",
  "ELIZA_API_EXPOSE_PORT",
  "ELIZA_BOOT_PROFILE",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function isolateEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function runtimeStub(
  reportError: AgentRuntime["reportError"] = vi.fn(),
): AgentRuntime {
  return { reportError } as unknown as AgentRuntime;
}

function createApiHandle(port: number): ApiHandle {
  return {
    port,
    updateRuntime: vi.fn(),
    updateStartup: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

function sandboxStub(overrides?: {
  register?: () => Promise<void>;
  unregister?: () => Promise<void>;
}) {
  return {
    register: vi.fn(overrides?.register ?? (async () => {})),
    unregister: vi.fn(overrides?.unregister ?? (async () => {})),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  };
}

function phasesOf(api: ApiHandle): string[] {
  return api.updateStartup.mock.calls.map((call) => {
    const update = call[0];
    if (!update) {
      throw new Error("updateStartup called without a snapshot");
    }
    return update.phase;
  });
}

function lastStartup(api: ApiHandle): StartupUpdate {
  const update = api.updateStartup.mock.calls.at(-1)?.[0];
  if (!update) {
    throw new Error("updateStartup was never called");
  }
  return update;
}

let lastApiOpts: StartApiServerOpts | undefined;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

async function startHost(
  deps: {
    options?: StartServerOnlyHostOptions["options"];
    bootRuntime?: StartServerOnlyHostOptions["bootRuntime"];
    stopRuntime?: StartServerOnlyHostOptions["stopRuntime"];
    stopWithoutRuntime?: StartServerOnlyHostOptions["stopWithoutRuntime"];
    bindPort?: number;
  } = {},
): Promise<{
  runtime: AgentRuntime;
  result: AgentRuntime | undefined;
  api: ApiHandle;
  bootRuntime: ReturnType<
    typeof vi.fn<StartServerOnlyHostOptions["bootRuntime"]>
  >;
  stopRuntime: ReturnType<
    typeof vi.fn<StartServerOnlyHostOptions["stopRuntime"]>
  >;
  stopWithoutRuntime: ReturnType<typeof vi.fn<() => void>>;
  onReady: ReturnType<
    typeof vi.fn<
      NonNullable<
        StartServerOnlyHostOptions["options"]["onServerOnlyHostReady"]
      >
    >
  >;
  publishPostReady: ((phase: PostReadyPhase) => void) | undefined;
}> {
  const runtime = runtimeStub();
  const requestedPort = Number(process.env.ELIZA_API_PORT ?? 2138);
  const api = createApiHandle(deps.bindPort ?? requestedPort);
  lastApiOpts = undefined;
  mocks.startApiServer.mockImplementation(async (opts: StartApiServerOpts) => {
    lastApiOpts = opts;
    return api;
  });

  let publishPostReady: ((phase: PostReadyPhase) => void) | undefined;
  const bootRuntime =
    deps.bootRuntime ??
    vi.fn(async (onPostReadyPhase: (phase: PostReadyPhase) => void) => {
      publishPostReady = onPostReadyPhase;
      return runtime;
    });
  const stopRuntime = deps.stopRuntime ?? vi.fn(async () => {});
  const stopWithoutRuntime = deps.stopWithoutRuntime ?? vi.fn();
  const onReady = vi.fn();

  const result = await startServerOnlyHost({
    options: {
      onServerOnlyHostReady: onReady,
      ...deps.options,
    },
    bootRuntime,
    stopRuntime,
    stopWithoutRuntime,
  });

  return {
    runtime,
    result,
    api,
    bootRuntime: bootRuntime as ReturnType<
      typeof vi.fn<StartServerOnlyHostOptions["bootRuntime"]>
    >,
    stopRuntime: stopRuntime as ReturnType<
      typeof vi.fn<StartServerOnlyHostOptions["stopRuntime"]>
    >,
    stopWithoutRuntime: stopWithoutRuntime as ReturnType<
      typeof vi.fn<() => void>
    >,
    onReady,
    publishPostReady,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  isolateEnv();
  mocks.startApiServer.mockReset();
  mocks.shouldDefer.mockReset();
  mocks.shouldDefer.mockReturnValue(false);
  mocks.buildSandboxRegistryFromEnv.mockReset();
  mocks.buildSandboxRegistryFromEnv.mockReturnValue(null);
  mocks.invalidateCorsAllowedPorts.mockReset();
  mocks.registerDeferredRuntimeBoot.mockClear();
  mocks.isRuntimeBootDeferred.mockClear();
  mocks.triggerDeferredRuntimeBoot.mockClear();
  mocks.resetDeferred();
  lastApiOpts = undefined;
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  mocks.resetDeferred();
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  restoreEnv();
});

describe("startServerOnlyHost exports", () => {
  it("exposes only the bind-first host entry", () => {
    expect(Object.keys(serverOnlyHostModule).sort()).toEqual([
      "startServerOnlyHost",
    ]);
  });
});

describe("port selection and listen policy", () => {
  it("binds the server-only default when ELIZA_API_PORT is unset", async () => {
    await startHost();

    expect(mocks.startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 2138,
        skipListen: false,
        initialAgentState: "starting",
      }),
    );
  });

  it("honors ELIZA_API_PORT through the desktop resolver", async () => {
    isolateEnv({ ELIZA_API_PORT: "32123" });
    await startHost();

    expect(mocks.startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 32123,
        skipListen: false,
      }),
    );
  });

  it("syncs a rebound listener into env and invalidates CORS", async () => {
    isolateEnv({ ELIZA_API_PORT: "32123" });
    await startHost({ bindPort: 9999 });

    expect(process.env.ELIZA_API_PORT).toBe("9999");
    expect(process.env.ELIZA_UI_PORT).toBe("9999");
    expect(process.env.ELIZA_PORT).toBe("9999");
    expect(mocks.invalidateCorsAllowedPorts).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] API server listening on http://localhost:9999 (agent booting…)",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Control UI: http://localhost:9999",
    );
  });

  it("skips TCP listen and does not sync a never-bound port in local-agent IPC mode", async () => {
    const started = await startHost({
      options: { localAgentMode: true },
    });

    expect(mocks.startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({ skipListen: true }),
    );
    expect(process.env.ELIZA_API_PORT).toBeUndefined();
    expect(process.env.ELIZA_UI_PORT).toBeUndefined();
    expect(mocks.invalidateCorsAllowedPorts).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Local-agent IPC mode: initializing route kernel without a TCP listener (set ELIZA_API_EXPOSE_PORT=1 to re-open the port)",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Local-agent IPC mode: route kernel ready (no TCP listener bound)",
    );
    expect(started.onReady).toHaveBeenCalledOnce();
  });

  it("re-opens the TCP listener when local-agent mode opts in with ELIZA_API_EXPOSE_PORT", async () => {
    isolateEnv({ ELIZA_API_EXPOSE_PORT: "1" });
    await startHost({ options: { localAgentMode: true } });

    expect(mocks.startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({ skipListen: false }),
    );
    expect(mocks.invalidateCorsAllowedPorts).toHaveBeenCalledOnce();
    expect(process.env.ELIZA_API_PORT).toBe("2138");
  });
});

describe("API bind failure", () => {
  it("logs an Error stack, skips boot, and rethrows the bind failure", async () => {
    const failure = new Error("address in use");
    mocks.startApiServer.mockRejectedValue(failure);
    const onReady = vi.fn();
    const bootRuntime = vi.fn(async () => runtimeStub());

    await expect(
      startServerOnlyHost({
        options: { onServerOnlyHostReady: onReady },
        bootRuntime,
        stopRuntime: vi.fn(async () => {}),
        stopWithoutRuntime: vi.fn(),
      }),
    ).rejects.toBe(failure);

    expect(bootRuntime).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      `[eliza] API server failed to start: ${failure.stack}`,
    );
  });

  it("stringifies a non-Error bind failure and prefers message when stack is missing", async () => {
    mocks.startApiServer.mockRejectedValueOnce("socket exploded");
    await expect(
      startServerOnlyHost({
        options: {},
        bootRuntime: vi.fn(async () => runtimeStub()),
        stopRuntime: vi.fn(async () => {}),
        stopWithoutRuntime: vi.fn(),
      }),
    ).rejects.toBe("socket exploded");
    expect(errorSpy).toHaveBeenCalledWith(
      "[eliza] API server failed to start: socket exploded",
    );

    const bare = new Error("bind failed");
    bare.stack = undefined;
    mocks.startApiServer.mockRejectedValueOnce(bare);
    await expect(
      startServerOnlyHost({
        options: {},
        bootRuntime: vi.fn(async () => runtimeStub()),
        stopRuntime: vi.fn(async () => {}),
        stopWithoutRuntime: vi.fn(),
      }),
    ).rejects.toBe(bare);
    expect(errorSpy).toHaveBeenCalledWith(
      "[eliza] API server failed to start: bind failed",
    );
  });
});

describe("immediate runtime boot", () => {
  it("binds first, boots, publishes pending as features-starting, and returns the runtime", async () => {
    const started = await startHost();

    expect(started.result).toBe(started.runtime);
    expect(started.api.updateRuntime).toHaveBeenCalledExactlyOnceWith(
      started.runtime,
    );
    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "runtime-starting",
      "features-starting",
    ]);
    expect(lastStartup(started.api)).toMatchObject({
      phase: "features-starting",
      attempt: 1,
      state: "running",
    });
    expect(started.onReady).toHaveBeenCalledOnce();
    const host = started.onReady.mock.calls[0]?.[0];
    expect(host?.port).toBe(2138);
    expect(host?.getRuntime()).toBe(started.runtime);
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Server running. Press Ctrl+C to stop.",
    );
  });

  it("maps a complete post-ready callback during boot to ready, not features-starting", async () => {
    const started = await startHost({
      bootRuntime: vi.fn(async (onPostReadyPhase) => {
        onPostReadyPhase("complete");
        return runtimeStub();
      }),
    });

    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "runtime-starting",
      "ready",
    ]);
    expect(lastStartup(started.api).state).toBe("running");
  });

  it("maps a failed post-ready callback during boot to degraded", async () => {
    const started = await startHost({
      bootRuntime: vi.fn(async (onPostReadyPhase) => {
        onPostReadyPhase("failed");
        return runtimeStub();
      }),
    });

    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "runtime-starting",
      "degraded",
    ]);
  });

  it("ignores post-ready publishes until the runtime is visible, then projects later phases", async () => {
    const started = await startHost();
    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "runtime-starting",
      "features-starting",
    ]);

    started.publishPostReady?.("complete");
    expect(lastStartup(started.api).phase).toBe("ready");

    started.publishPostReady?.("failed");
    expect(lastStartup(started.api).phase).toBe("degraded");

    expect(() => started.publishPostReady?.("pending")).toThrow(
      "Invalid startup transition: degraded -> features-starting",
    );
  });

  it("closes the API and rethrows when the initial boot throws", async () => {
    const failure = new Error("plugin load failed");
    const started = await startHost({
      bootRuntime: vi.fn(async () => {
        throw failure;
      }),
    }).catch((error: unknown) => error);

    expect(started).toBe(failure);
    const api = mocks.startApiServer.mock.results[0]
      ?.value as Promise<ApiHandle>;
    const handle = await api;
    expect(handle.close).toHaveBeenCalledOnce();
    expect(lastStartup(handle)).toMatchObject({
      phase: "failed",
      state: "error",
    });
  });

  it("closes the API and returns undefined when boot yields no runtime, without publishing a host", async () => {
    const started = await startHost({
      bootRuntime: vi.fn(async () => undefined),
    });

    expect(started.result).toBeUndefined();
    expect(started.api.close).toHaveBeenCalledOnce();
    expect(started.api.updateRuntime).not.toHaveBeenCalled();
    expect(started.onReady).not.toHaveBeenCalled();
    expect(lastStartup(started.api)).toMatchObject({
      phase: "failed",
      state: "error",
    });
  });
});

describe("deferred onboarding boot", () => {
  it("registers a deferred boot, binds as not_started, and does not boot immediately", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const started = await startHost();

    expect(mocks.registerDeferredRuntimeBoot).toHaveBeenCalledOnce();
    expect(mocks.isRuntimeBootDeferred()).toBe(true);
    expect(started.bootRuntime).not.toHaveBeenCalled();
    expect(started.result).toBeUndefined();
    expect(mocks.startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({ initialAgentState: "not_started" }),
    );
    expect(phasesOf(started.api)).toEqual(["api-bound", "awaiting-onboarding"]);
    expect(lastStartup(started.api)).toMatchObject({
      phase: "awaiting-onboarding",
      state: "not_started",
      attempt: 0,
    });
    expect(started.onReady.mock.calls[0]?.[0]?.getRuntime()).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Fresh install — agent runtime boot deferred until onboarding commits (onboarding API routes are live)",
    );
  });

  it("boots, publishes, and clears deferral when the registered closure succeeds", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const started = await startHost();

    await mocks.triggerDeferredRuntimeBoot("first-run commit");

    expect(started.bootRuntime).toHaveBeenCalledOnce();
    expect(started.api.updateRuntime).toHaveBeenCalledExactlyOnceWith(
      started.runtime,
    );
    expect(mocks.isRuntimeBootDeferred()).toBe(false);
    expect(started.onReady.mock.calls[0]?.[0]?.getRuntime()).toBe(
      started.runtime,
    );
    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "awaiting-onboarding",
      "runtime-starting",
      "features-starting",
    ]);
    expect(lastStartup(started.api).attempt).toBe(1);
  });

  it("wraps a deferred boot throw, flips failed, and keeps the registration for retry", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const failure = new Error("migrations failed");
    await startHost({
      bootRuntime: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      mocks.triggerDeferredRuntimeBoot("agent start requested via API"),
    ).rejects.toMatchObject({
      message: "Runtime boot after onboarding failed",
      cause: failure,
    });
    expect(mocks.isRuntimeBootDeferred()).toBe(true);
  });

  it("throws when the deferred boot returns no runtime and keeps the registration", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const started = await startHost({
      bootRuntime: vi.fn(async () => undefined),
    });

    await expect(mocks.triggerDeferredRuntimeBoot("retry")).rejects.toThrow(
      "Runtime boot after onboarding returned no runtime",
    );
    expect(mocks.isRuntimeBootDeferred()).toBe(true);
    expect(started.api.updateRuntime).not.toHaveBeenCalled();
    expect(lastStartup(started.api)).toMatchObject({
      phase: "failed",
      state: "error",
    });
  });
});

describe("onRestart", () => {
  it("funnels a restart into the deferred boot while registration is live", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const started = await startHost();
    expect(lastApiOpts?.onRestart).toBeTypeOf("function");

    const restarted = await lastApiOpts?.onRestart();

    expect(restarted).toBe(started.runtime);
    expect(started.bootRuntime).toHaveBeenCalledOnce();
    expect(started.stopRuntime).not.toHaveBeenCalled();
    expect(mocks.triggerDeferredRuntimeBoot).toHaveBeenCalledWith(
      "agent start requested via API",
    );
    expect(mocks.isRuntimeBootDeferred()).toBe(false);
  });

  it("stops the live runtime, reboots, and returns the new runtime", async () => {
    const first = runtimeStub();
    const second = runtimeStub();
    const bootRuntime = vi
      .fn<StartServerOnlyHostOptions["bootRuntime"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const started = await startHost({ bootRuntime });

    const restarted = await lastApiOpts?.onRestart();

    expect(started.stopRuntime).toHaveBeenCalledExactlyOnceWith(
      first,
      "server-only restart",
    );
    expect(restarted).toBe(second);
    expect(phasesOf(started.api)).toEqual([
      "api-bound",
      "runtime-starting",
      "features-starting",
      "runtime-starting",
      "features-starting",
    ]);
    expect(lastStartup(started.api).attempt).toBe(2);
    expect(started.onReady.mock.calls[0]?.[0]?.getRuntime()).toBe(second);
  });

  it("publishes failed and rethrows the original boot error on restart", async () => {
    const failure = new Error("restart boot failed");
    const bootRuntime = vi
      .fn<StartServerOnlyHostOptions["bootRuntime"]>()
      .mockResolvedValueOnce(runtimeStub())
      .mockRejectedValueOnce(failure);
    const started = await startHost({ bootRuntime });

    await expect(lastApiOpts?.onRestart()).rejects.toBe(failure);
    expect(lastStartup(started.api)).toMatchObject({
      phase: "failed",
      state: "error",
    });
    expect(started.api.close).not.toHaveBeenCalled();
  });

  it("returns null and does not close the API when restart boot yields no runtime", async () => {
    const bootRuntime = vi
      .fn<StartServerOnlyHostOptions["bootRuntime"]>()
      .mockResolvedValueOnce(runtimeStub())
      .mockResolvedValueOnce(undefined);
    const started = await startHost({ bootRuntime });

    await expect(lastApiOpts?.onRestart()).resolves.toBeNull();
    expect(started.api.close).not.toHaveBeenCalled();
    expect(lastStartup(started.api)).toMatchObject({
      phase: "failed",
      state: "error",
    });
  });

  it("boots without stopRuntime when no runtime is published and deferral is clear", async () => {
    const started = await startHost({
      bootRuntime: vi.fn(async () => undefined),
    });
    expect(started.result).toBeUndefined();
    const replacement = runtimeStub();
    started.bootRuntime.mockResolvedValueOnce(replacement);

    const restarted = await lastApiOpts?.onRestart();

    expect(started.stopRuntime).not.toHaveBeenCalled();
    expect(restarted).toBe(replacement);
    expect(started.onReady).not.toHaveBeenCalled();
  });
});

describe("sandbox registry", () => {
  it("registers and starts a 30s heartbeat when env builds a registry", async () => {
    const registry = sandboxStub();
    mocks.buildSandboxRegistryFromEnv.mockReturnValue(registry);

    await startHost();

    expect(registry.register).toHaveBeenCalledOnce();
    expect(registry.startHeartbeat).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  it("reports a register failure on the runtime and still starts the heartbeat", async () => {
    const failure = new Error("redis down");
    const registry = sandboxStub({
      register: async () => {
        throw failure;
      },
    });
    mocks.buildSandboxRegistryFromEnv.mockReturnValue(registry);
    const reportError = vi.fn();
    const runtime = runtimeStub(reportError);

    await startHost({
      bootRuntime: vi.fn(async () => runtime),
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "[eliza] Failed to register sandbox in Redis (gateways will not route inbound platform messages here until the next heartbeat succeeds): redis down",
    );
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "eliza.sandboxRegistry",
      failure,
      { phase: "register" },
    );
    expect(registry.startHeartbeat).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  it("does not report a register failure when no runtime exists yet", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const failure = new Error("redis down");
    const registry = sandboxStub({
      register: async () => {
        throw failure;
      },
    });
    mocks.buildSandboxRegistryFromEnv.mockReturnValue(registry);

    await startHost();

    expect(errorSpy).toHaveBeenCalled();
    expect(registry.startHeartbeat).toHaveBeenCalledOnce();
  });
});

describe("close", () => {
  it("stops the API and runtime once, even when close is invoked twice", async () => {
    const started = await startHost();
    const host = started.onReady.mock.calls[0]?.[0];
    if (!host) {
      throw new Error("onServerOnlyHostReady was not invoked");
    }

    await host.close();
    await host.close();

    expect(started.api.close).toHaveBeenCalledTimes(1);
    expect(started.stopRuntime).toHaveBeenCalledExactlyOnceWith(
      started.runtime,
      "server-only shutdown",
    );
    expect(started.stopWithoutRuntime).not.toHaveBeenCalled();
    expect(lastStartup(started.api)).toMatchObject({
      phase: "stopping",
      state: "stopped",
    });
  });

  it("calls stopWithoutRuntime when closing a host that never published a runtime", async () => {
    mocks.shouldDefer.mockReturnValue(true);
    const started = await startHost();
    const host = started.onReady.mock.calls[0]?.[0];
    if (!host) {
      throw new Error("onServerOnlyHostReady was not invoked");
    }

    await host.close();

    expect(started.stopWithoutRuntime).toHaveBeenCalledOnce();
    expect(started.stopRuntime).not.toHaveBeenCalled();
  });

  it("stops the heartbeat and unregisters the sandbox on close", async () => {
    const registry = sandboxStub();
    mocks.buildSandboxRegistryFromEnv.mockReturnValue(registry);
    const started = await startHost();
    const host = started.onReady.mock.calls[0]?.[0];
    if (!host) {
      throw new Error("onServerOnlyHostReady was not invoked");
    }

    await host.close();

    expect(registry.stopHeartbeat).toHaveBeenCalledOnce();
    expect(registry.unregister).toHaveBeenCalledOnce();
  });

  it("warns on unregister failure and still stops the runtime", async () => {
    const failure = new Error("ttl leftover");
    const registry = sandboxStub({
      unregister: async () => {
        throw failure;
      },
    });
    mocks.buildSandboxRegistryFromEnv.mockReturnValue(registry);
    const started = await startHost();
    const host = started.onReady.mock.calls[0]?.[0];
    if (!host) {
      throw new Error("onServerOnlyHostReady was not invoked");
    }

    await host.close();

    expect(warnSpy).toHaveBeenCalledWith(
      "[eliza] Sandbox unregister failed (keys will expire via TTL): ttl leftover",
    );
    expect(started.stopRuntime).toHaveBeenCalledOnce();
  });
});
