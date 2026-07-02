import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

/**
 * Regression coverage for the coordinator "silent bind give-up" bug.
 *
 * BEFORE the fix, `SwarmCoordinatorService` polled `getService(ACP)` at
 * 500ms x 120 = 60s and then gave up SILENTLY, setting `acpBindTimer = null`
 * and never re-arming. On a heavy boot where AcpService registered later than
 * 60s (big character, many plugins, embedding warmup), the coordinator went
 * permanently inert while its service object still existed — so the 90s wiring
 * probe "succeeded" and set its callbacks, but no ACP events ever reached them.
 *
 * These tests drive that exact race with fake timers:
 *   - late-registration (ACP appears at ~70s) must still bind (was: dead).
 *   - normal boot (ACP present immediately) binds without retries.
 *   - ACP load-promise rejection marks the coordinator UNBOUND loudly.
 *   - never-registers keeps retrying (unbounded) instead of going silent.
 */

/** Minimal fake ACP service exposing just the `onSessionEvent` surface. */
function makeFakeAcp(): {
  acp: Pick<AcpService, "onSessionEvent">;
  emit: (sessionId: string, event: string, data: unknown) => void;
  subscriberCount: () => number;
} {
  const handlers: Array<
    (sessionId: string, event: string, data: unknown) => void
  > = [];
  return {
    acp: {
      onSessionEvent(handler) {
        handlers.push(handler as (s: string, e: string, d: unknown) => void);
        return () => {
          const i = handlers.indexOf(
            handler as (s: string, e: string, d: unknown) => void,
          );
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    } as Pick<AcpService, "onSessionEvent">,
    emit: (sessionId, event, data) => {
      for (const h of [...handlers]) h(sessionId, event, data);
    },
    subscriberCount: () => handlers.length,
  };
}

interface FakeRuntimeControls {
  runtime: IAgentRuntime;
  /** Make the ACP service discoverable via getService + resolve its load-promise. */
  registerAcp: (acp: unknown) => void;
  /** Reject the ACP load-promise (ACP failed to start). */
  failAcpStart: (err: Error) => void;
}

/**
 * A runtime that models the two discovery surfaces the coordinator uses:
 *   - `getService(ACP)` — sync lookup, null until `registerAcp`.
 *   - `getServiceLoadPromise(ACP)` — event-driven, resolves on `registerAcp`
 *     or rejects on `failAcpStart`.
 * `driveLoadPromise` toggles whether the load-promise surface exists, so we can
 * exercise both the event-driven path and the polling fallback in isolation.
 */
function makeRuntime(
  opts: { driveLoadPromise: boolean } = { driveLoadPromise: true },
): FakeRuntimeControls {
  let acpInstance: unknown = null;
  let resolveLoad: ((svc: unknown) => void) | null = null;
  let rejectLoad: ((err: Error) => void) | null = null;
  const loadPromise = new Promise<unknown>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  // Prevent unhandled-rejection noise before anyone awaits.
  loadPromise.catch(() => {});

  const runtime = {
    getService: (serviceType: string) =>
      serviceType === AcpService.serviceType ? acpInstance : null,
    getServiceLoadPromise: opts.driveLoadPromise
      ? (serviceType: string) =>
          serviceType === AcpService.serviceType
            ? loadPromise
            : Promise.reject(new Error("no such service"))
      : undefined,
  } as unknown as IAgentRuntime;

  return {
    runtime,
    registerAcp: (acp: unknown) => {
      acpInstance = acp;
      resolveLoad?.(acp);
    },
    failAcpStart: (err: Error) => {
      rejectLoad?.(err);
    },
  };
}

describe("SwarmCoordinatorService ACP bind race (coordinator silent give-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("binds when ACP registers LATE (~70s > old 60s give-up window) — the regression", async () => {
    // Polling-fallback ONLY: this is the path that previously gave up at 60s.
    const { runtime, registerAcp } = makeRuntime({ driveLoadPromise: false });
    const { acp, emit, subscriberCount } = makeFakeAcp();

    const service = new SwarmCoordinatorService(runtime);
    // start() calls bindToAcp(); construct-and-bind manually to mirror it.
    (service as unknown as { bindToAcp: () => void }).bindToAcp();

    expect(service.acpBindState.status).toBe("pending");

    // Advance PAST the old 60s give-up point. On develop HEAD the poll loop
    // has stopped by now (acpBindTimer = null) and never re-arms.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(service.acpBindState.status).toBe("pending"); // still trying

    // ACP finally starts at ~70s.
    registerAcp(acp);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(service.acpBindState.status).toBe("bound");
    expect(subscriberCount()).toBe(1);

    // And the event stream is actually live.
    const seen: string[] = [];
    service.subscribe((e) => seen.push(e.type));
    emit("s1", "task_complete", {});
    // handleAcpEvent is async (enrichment + dispatch happen after awaits); let
    // the microtask queue drain before asserting the listener fired.
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(seen).toContain("task_complete");

    await service.stop();
  });

  it("binds via the event-driven load-promise when ACP starts late", async () => {
    const { runtime, registerAcp } = makeRuntime({ driveLoadPromise: true });
    const { acp, subscriberCount } = makeFakeAcp();

    const service = new SwarmCoordinatorService(runtime);
    (service as unknown as { bindToAcp: () => void }).bindToAcp();
    expect(service.acpBindState.status).toBe("pending");

    // Simulate a very slow boot: 70s, still nothing.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(service.acpBindState.status).toBe("pending");

    // ACP start resolves the load-promise; bind should complete promptly.
    registerAcp(acp);
    await vi.advanceTimersByTimeAsync(10);

    expect(service.acpBindState.status).toBe("bound");
    expect(subscriberCount()).toBe(1);
    await service.stop();
  });

  it("normal boot: binds immediately with zero retries", async () => {
    const { runtime, registerAcp } = makeRuntime();
    const { acp, subscriberCount } = makeFakeAcp();
    registerAcp(acp); // ACP already up before the coordinator starts

    const service = new SwarmCoordinatorService(runtime);
    (service as unknown as { bindToAcp: () => void }).bindToAcp();
    await vi.advanceTimersByTimeAsync(1);

    expect(service.acpBindState.status).toBe("bound");
    expect(service.acpBindState.attempts).toBe(0);
    expect(subscriberCount()).toBe(1);
    await service.stop();
  });

  it("marks UNBOUND loudly when ACP fails to start (load-promise rejects)", async () => {
    const _errorSpy = vi.fn();
    const { runtime, failAcpStart } = makeRuntime({ driveLoadPromise: true });
    const { subscriberCount } = makeFakeAcp();

    const service = new SwarmCoordinatorService(runtime);
    (service as unknown as { bindToAcp: () => void }).bindToAcp();

    failAcpStart(new Error("acp subprocess crashed"));
    await vi.advanceTimersByTimeAsync(10);

    expect(service.acpBindState.status).toBe("unbound");
    expect(service.acpBindState.reason).toContain("acp subprocess crashed");
    expect(subscriberCount()).toBe(0);
    await service.stop();
  });

  it("never-registers: keeps retrying indefinitely (does not go silent)", async () => {
    // Polling fallback with no load-promise and ACP that never appears.
    const { runtime } = makeRuntime({ driveLoadPromise: false });
    const service = new SwarmCoordinatorService(runtime);
    (service as unknown as { bindToAcp: () => void }).bindToAcp();

    // Push far past every old give-up point.
    await vi.advanceTimersByTimeAsync(300_000);

    // Still pending (retrying), NOT silently abandoned.
    expect(service.acpBindState.status).toBe("pending");
    expect(service.acpBindState.attempts).toBeGreaterThan(120);

    // Proves the retry timer is still armed: registering now still binds.
    const { acp } = makeFakeAcp();
    (runtime.getService as unknown) = (t: string) =>
      t === AcpService.serviceType ? acp : null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.acpBindState.status).toBe("bound");

    await service.stop();
  });
});
