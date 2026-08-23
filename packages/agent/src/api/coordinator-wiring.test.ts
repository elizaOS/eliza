/**
 * Behavioral coverage for `wireCoordinatorBridgesWhenReady`: immediate wiring,
 * missing runtime, poll/retry against the real `getSwarmCoordinatorService`
 * lookup, ACP bind degradation, runtime-swap supersession, retry exhaustion
 * warnings, and error isolation. Injected bridges are test doubles; the wiring
 * module itself is not mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type WirableState,
  type WireCoordinatorOpts,
  wireCoordinatorBridgesWhenReady,
} from "./coordinator-wiring.ts";

type Runtime = NonNullable<WirableState["runtime"]>;

function createRuntime(options?: { service?: unknown; hasService?: boolean }): {
  runtime: Runtime;
  box: { service: unknown; hasService?: boolean; serviceTypes: string[] };
} {
  const box: {
    service: unknown;
    hasService?: boolean;
    serviceTypes: string[];
  } = {
    service: options?.service ?? null,
    hasService: options?.hasService,
    serviceTypes: [],
  };
  const runtime = {
    getService(serviceType: string) {
      box.serviceTypes.push(serviceType);
      return serviceType === "SWARM_COORDINATOR" ? box.service : null;
    },
    ...(options?.hasService === undefined
      ? {}
      : {
          hasService(serviceType: string) {
            return (
              serviceType === "SWARM_COORDINATOR" && box.hasService === true
            );
          },
        }),
  } as unknown as Runtime;
  return { runtime, box };
}

function createLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function createOpts(
  overrides?: Partial<WireCoordinatorOpts>,
): WireCoordinatorOpts {
  return {
    wireChatBridge: vi.fn(async () => false),
    wireWsBridge: vi.fn(async () => false),
    wireEventRouting: vi.fn(async () => false),
    context: "boot",
    logger: createLogger(),
    ...overrides,
  };
}

function boundCoordinator(status = "bound", reason: string | null = null) {
  return { acpBindState: { status, reason, attempts: 1 } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("wireCoordinatorBridgesWhenReady", () => {
  it("returns immediately when the required bridges wire on the first attempt", async () => {
    const { runtime } = createRuntime();
    const opts = createOpts({
      wireChatBridge: vi.fn(async () => true),
      wireWsBridge: vi.fn(async () => true),
      wireEventRouting: vi.fn(async () => true),
      wireSwarmSynthesis: vi.fn(async () => true),
    });

    const result = await wireCoordinatorBridgesWhenReady({ runtime }, opts);

    expect(result).toEqual({
      chat: true,
      ws: true,
      eventRouting: true,
      swarmSynthesis: true,
    });
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] Coordinator bridges wired immediately (boot)",
    );
    expect(opts.wireChatBridge).toHaveBeenCalledTimes(1);
    expect(opts.logger.warn).not.toHaveBeenCalled();
  });

  it("returns immediately even when optional swarm synthesis is omitted or fails", async () => {
    const { runtime } = createRuntime();
    const withoutSynthesis = await wireCoordinatorBridgesWhenReady(
      { runtime },
      createOpts({
        wireChatBridge: vi.fn(async () => true),
        wireWsBridge: vi.fn(async () => true),
        wireEventRouting: vi.fn(async () => true),
      }),
    );
    expect(withoutSynthesis).toEqual({
      chat: true,
      ws: true,
      eventRouting: true,
      swarmSynthesis: false,
    });

    const failedSynthesis = await wireCoordinatorBridgesWhenReady(
      { runtime },
      createOpts({
        wireChatBridge: vi.fn(async () => true),
        wireWsBridge: vi.fn(async () => true),
        wireEventRouting: vi.fn(async () => true),
        wireSwarmSynthesis: vi.fn(async () => false),
      }),
    );
    expect(failedSynthesis.swarmSynthesis).toBe(false);
    expect(failedSynthesis.chat).toBe(true);
  });

  it("skips polling and warns when required bridges fail and runtime is missing", async () => {
    const broadcastWs = vi.fn();
    const opts = createOpts({
      wireSwarmSynthesis: vi.fn(async () => false),
    });

    const result = await wireCoordinatorBridgesWhenReady(
      { runtime: null, broadcastWs },
      opts,
    );

    expect(result).toEqual({
      chat: false,
      ws: false,
      eventRouting: false,
      swarmSynthesis: false,
    });
    expect(opts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] Coordinator wiring skipped (boot): no runtime",
    );
    expect(broadcastWs).not.toHaveBeenCalled();
    expect(opts.logger.debug).not.toHaveBeenCalled();
  });

  it("stops polling when the runtime is swapped before the coordinator appears", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime();
    const state: WirableState = { runtime };
    const opts = createOpts();

    const pending = wireCoordinatorBridgesWhenReady(state, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    state.runtime = createRuntime().runtime;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.chat).toBe(false);
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] coordinator polling superseded by runtime swap (boot)",
    );
    expect(opts.logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("coordinator service detected"),
    );
    expect(opts.wireChatBridge).toHaveBeenCalledTimes(1);
  });

  it("discovers the coordinator through SWARM_COORDINATOR and retries only failed bridges", async () => {
    vi.useFakeTimers();
    const { runtime, box } = createRuntime({
      service: boundCoordinator(),
    });
    const opts = createOpts({
      wireChatBridge: vi.fn(async () => true),
      wireWsBridge: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      wireEventRouting: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(box.serviceTypes).toContain("SWARM_COORDINATOR");
    expect(result).toEqual({
      chat: true,
      ws: true,
      eventRouting: true,
      swarmSynthesis: false,
    });
    expect(opts.wireChatBridge).toHaveBeenCalledTimes(1);
    expect(opts.wireWsBridge).toHaveBeenCalledTimes(2);
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] coordinator service detected (boot)",
    );
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] Coordinator bridges wired after service load (boot, attempt 1)",
    );
    expect(opts.logger.warn).not.toHaveBeenCalled();
  });

  it("succeeds on a later retry after the coordinator appears", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({ service: boundCoordinator() });
    const opts = createOpts({
      wireChatBridge: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      wireWsBridge: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      wireEventRouting: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result.chat && result.ws && result.eventRouting).toBe(true);
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] Coordinator bridges wired after service load (boot, attempt 2)",
    );
  });

  it("warns when the coordinator is present but the ACP stream is unbound with a reason", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({
      service: boundCoordinator("unbound", "acp socket closed"),
    });
    const opts = createOpts({
      wireChatBridge: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      wireWsBridge: vi.fn(async () => true),
      wireEventRouting: vi.fn(async () => true),
    });

    const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(opts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] coordinator present but ACP stream not bound (status=unbound, reason=acp socket closed) (boot) — coding-agent supervision DEGRADED. Bridges will wire but events will not flow until the bind completes; the coordinator retries indefinitely.",
    );
  });

  it("omits the reason clause when ACP bind status is pending without a string reason", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({
      service: { acpBindState: { status: "pending", reason: 12, attempts: 0 } },
    });
    const opts = createOpts({
      wireChatBridge: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      wireWsBridge: vi.fn(async () => true),
      wireEventRouting: vi.fn(async () => true),
    });

    const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(opts.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("status=pending) (boot)"),
    );
    expect(opts.logger.warn).toHaveBeenCalledWith(
      expect.not.stringContaining("reason="),
    );
  });

  it("does not warn about ACP bind when bind state is missing or malformed", async () => {
    vi.useFakeTimers();

    async function wireWithService(service: unknown) {
      const { runtime } = createRuntime({ service });
      const opts = createOpts({
        wireChatBridge: vi
          .fn(async () => false)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        wireWsBridge: vi.fn(async () => true),
        wireEventRouting: vi.fn(async () => true),
      });
      const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      return opts;
    }

    const missing = await wireWithService({ acpBindState: null });
    const malformed = await wireWithService({
      acpBindState: { status: 7, reason: "x" },
    });
    const primitive = await wireWithService(1);

    expect(missing.logger.warn).not.toHaveBeenCalled();
    expect(malformed.logger.warn).not.toHaveBeenCalled();
    expect(primitive.logger.warn).not.toHaveBeenCalled();
  });

  it("broadcasts a system-warning listing every still-missing bridge after retries exhaust", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({ service: boundCoordinator() });
    const broadcastWs = vi.fn();
    const opts = createOpts({
      wireSwarmSynthesis: vi.fn(async () => false),
      context: "restart",
    });

    const pending = wireCoordinatorBridgesWhenReady(
      { runtime, broadcastWs },
      opts,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;

    expect(result).toEqual({
      chat: false,
      ws: false,
      eventRouting: false,
      swarmSynthesis: false,
    });
    expect(opts.wireChatBridge).toHaveBeenCalledTimes(6);
    expect(broadcastWs).toHaveBeenCalledTimes(1);
    const payload = broadcastWs.mock.calls[0]?.[0] as {
      type: string;
      message: string;
      ts: number;
    };
    expect(payload.type).toBe("system-warning");
    expect(payload.ts).toEqual(expect.any(Number));
    expect(payload.message).toBe(
      "Coordinator wiring missing bridges (restart): retries exhausted after service load. Missing bridges: chat, ws, event-routing, swarm-synthesis",
    );
    expect(opts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] Coordinator wiring missing bridges after 5 retries (restart)",
    );
  });

  it("omits swarm-synthesis from the warning when that callback was not provided", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({ service: boundCoordinator() });
    const broadcastWs = vi.fn();
    const opts = createOpts({
      wireChatBridge: vi.fn(async () => true),
    });

    const pending = wireCoordinatorBridgesWhenReady(
      { runtime, broadcastWs },
      opts,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;

    const payload = broadcastWs.mock.calls[0]?.[0] as { message: string };
    expect(payload.message).toContain("Missing bridges: ws, event-routing");
    expect(payload.message).not.toContain("swarm-synthesis");
    expect(payload.message).not.toContain("chat");
  });

  it("does not throw when retries exhaust without broadcastWs or logger.debug", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({ service: boundCoordinator() });
    const opts: WireCoordinatorOpts = {
      wireChatBridge: async () => false,
      wireWsBridge: async () => false,
      wireEventRouting: async () => false,
      context: "boot",
      logger: { warn: vi.fn() },
    };

    const pending = wireCoordinatorBridgesWhenReady({ runtime }, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    expect(result.chat).toBe(false);
    expect(opts.logger.warn).toHaveBeenCalled();
  });

  it("isolates thrown Error and non-Error values from the wire callbacks", async () => {
    const errorOpts = createOpts({
      wireChatBridge: vi.fn(async () => {
        throw new Error("chat exploded");
      }),
    });
    const errorResult = await wireCoordinatorBridgesWhenReady(
      { runtime: null },
      errorOpts,
    );
    expect(errorResult.chat).toBe(false);
    expect(errorOpts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] Coordinator wiring error (boot): chat exploded",
    );

    const stringOpts = createOpts({
      wireWsBridge: vi.fn(async () => {
        throw "ws-down";
      }),
    });
    await wireCoordinatorBridgesWhenReady({ runtime: null }, stringOpts);
    expect(stringOpts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] Coordinator wiring error (boot): ws-down",
    );
  });

  it("warns after 90s when the service is registered but not yet discoverable", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime({ hasService: true, service: null });
    const state: WirableState = { runtime };
    const opts = createOpts();

    const pending = wireCoordinatorBridgesWhenReady(state, opts);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(opts.logger.warn).toHaveBeenCalledWith(
      "[eliza-api] coordinator service registered but not yet discoverable after 90s (boot) — still polling; coding-agent features stay disabled until it appears.",
    );
    state.runtime = createRuntime().runtime;
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("debugs after 90s when the coordinator plugin is not installed", async () => {
    vi.useFakeTimers();
    const { runtime } = createRuntime();
    const state: WirableState = { runtime };
    const opts = createOpts();

    const pending = wireCoordinatorBridgesWhenReady(state, opts);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(opts.logger.debug).toHaveBeenCalledWith(
      "[eliza-api] coordinator not available after 90s (boot) — still polling (deferred plugin may not have loaded yet).",
    );
    expect(opts.logger.warn).not.toHaveBeenCalled();
    state.runtime = createRuntime().runtime;
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
});
