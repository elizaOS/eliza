/**
 * Unit coverage for the post-ready boot tail phase split in `eliza.ts`:
 * `getDeferAppRoutesEnabled` (the ELIZA_DEFER_APP_ROUTES === "1" truth table) and
 * `runPostReadyBootTail`, which runs the post-ready-safe boot steps — TTS, app
 * routes, runtime hooks, sensitive-request adapters, credential bridge, trigger
 * bridge, connector catalog, voice warmup — in declared order. Tests drive
 * injected step stubs to assert step ordering, deferred-mode dispatch (the caller
 * returns before a hung app-route load settles), the superseded-runtime teardown
 * guard, and per-step error isolation.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __setLatestBootTailRuntimeForTest,
  getDeferAppRoutesEnabled,
  type PostReadyBootSteps,
  runPostReadyBootTail,
} from "./eliza.ts";

// A minimal stand-in: the post-ready tail only ever passes the runtime through
// to the injected step stubs, so identity is all that matters here.
function makeFakeRuntime(): AgentRuntime {
  return {} as AgentRuntime;
}

// Build a fresh set of step stubs plus a shared call-order log. Each stub
// records its name so ordering can be asserted; deferrals/throws are layered on
// top per-test.
function makeSteps(): { steps: PostReadyBootSteps; order: string[] } {
  const order: string[] = [];
  const record =
    <T>(name: string, result: T) =>
    () => {
      order.push(name);
      return result;
    };
  const steps: PostReadyBootSteps = {
    ensureTextToSpeechHandler: vi.fn(record("tts", Promise.resolve())),
    registerAppRoutePlugins: vi.fn(record("appRoutes", Promise.resolve())),
    registerRuntimeHooks: vi.fn(record("runtimeHooks", Promise.resolve())),
    registerCoreSensitiveRequestAdapters: vi.fn(record("sensitive", undefined)),
    registerSubAgentCredentialBridge: vi.fn(
      record("credentialBridgeWiring", Promise.resolve()),
    ),
    registerSubAgentCredentialBridgeAdapter: vi.fn(
      record("credentialBridgeAdapter", true),
    ),
    ensureTriggerEventBridge: vi.fn(record("triggerBridge", Promise.resolve())),
    ensureConnectorTargetCatalog: vi.fn(record("catalog", Promise.resolve())),
    startDeferredVoiceWarmup: vi.fn(record("voiceWarmup", undefined)),
  };
  return { steps, order };
}

describe("getDeferAppRoutesEnabled (parser truth table)", () => {
  it("returns false for undefined / empty / 0 / false / true; true only for '1'", () => {
    expect(getDeferAppRoutesEnabled({})).toBe(false);
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "0" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "false" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "true" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "1" })).toBe(
      true,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "  1  " })).toBe(
      true,
    );
  });
});

describe("runPostReadyBootTail — phase split", () => {
  afterEach(() => {
    __setLatestBootTailRuntimeForTest(null);
    vi.restoreAllMocks();
  });

  it("(default-unset ordering) awaits every tail step in declared order", async () => {
    const runtime = makeFakeRuntime();
    __setLatestBootTailRuntimeForTest(runtime);
    const { steps, order } = makeSteps();

    await runPostReadyBootTail(runtime, steps);

    // ensureLocalInferenceHandler + autonomy are PRE-ready (inline in
    // repairRuntimeAfterBoot) and intentionally absent from the tail; the tail
    // owns exactly these post-ready-safe steps, in this order.
    expect(order).toEqual([
      "tts",
      "appRoutes",
      "runtimeHooks",
      "sensitive",
      "credentialBridgeAdapter",
      "credentialBridgeWiring",
      "triggerBridge",
      "catalog",
      "voiceWarmup",
    ]);
  });

  it("(deferred dispatch) the tail does not resolve until the hung app-route load settles, but the caller that voids it returns immediately", async () => {
    const runtime = makeFakeRuntime();
    __setLatestBootTailRuntimeForTest(runtime);
    const { steps } = makeSteps();

    // Make registerAppRoutePlugins hang on a never-auto-resolving deferred to
    // model the slow ready-path cost; the deferred-mode caller voids the tail
    // and returns before this settles.
    let releaseAppRoutes!: () => void;
    const appRoutesGate = new Promise<void>((resolve) => {
      releaseAppRoutes = resolve;
    });
    steps.registerAppRoutePlugins = vi.fn(() => appRoutesGate);

    let tailResolved = false;
    const tail = runPostReadyBootTail(runtime, steps).then(() => {
      tailResolved = true;
    });

    // Model the flag-set dispatch: caller returns control without awaiting.
    await Promise.resolve();
    expect(tailResolved).toBe(false);
    expect(steps.ensureConnectorTargetCatalog).not.toHaveBeenCalled();

    releaseAppRoutes();
    await tail;
    expect(tailResolved).toBe(true);
    expect(steps.ensureConnectorTargetCatalog).toHaveBeenCalledOnce();
  });

  it("(torn-down guard) skips all mutations and logs when the runtime is superseded", async () => {
    const supersededRuntime = makeFakeRuntime();
    const liveRuntime = makeFakeRuntime();
    // A newer boot has claimed the slot.
    __setLatestBootTailRuntimeForTest(liveRuntime);
    const { steps, order } = makeSteps();

    await runPostReadyBootTail(supersededRuntime, steps);

    expect(order).toEqual([]);
    expect(steps.registerAppRoutePlugins).not.toHaveBeenCalled();
    expect(steps.registerCoreSensitiveRequestAdapters).not.toHaveBeenCalled();
    expect(
      steps.registerSubAgentCredentialBridgeAdapter,
    ).not.toHaveBeenCalled();
    expect(steps.registerSubAgentCredentialBridge).not.toHaveBeenCalled();
    expect(steps.ensureTriggerEventBridge).not.toHaveBeenCalled();
    expect(steps.startDeferredVoiceWarmup).not.toHaveBeenCalled();
  });

  it("(error isolation) an app-route loader that resolves quietly does not reject the tail", async () => {
    const runtime = makeFakeRuntime();
    __setLatestBootTailRuntimeForTest(runtime);
    const { steps } = makeSteps();
    // registerAppRoutePlugins isolates per-loader failures internally and
    // resolves (never rejects), so the tail completes normally.
    steps.registerAppRoutePlugins = vi.fn(() => Promise.resolve());

    await expect(runPostReadyBootTail(runtime, steps)).resolves.toBeUndefined();
    expect(steps.ensureConnectorTargetCatalog).toHaveBeenCalledOnce();
  });

  it("(error isolation) a throwing pre-ready-class step (TTS / runtime hooks) rejects the tail", async () => {
    const runtime = makeFakeRuntime();
    __setLatestBootTailRuntimeForTest(runtime);
    const { steps } = makeSteps();
    const boom = new Error("tts handler registration failed");
    steps.ensureTextToSpeechHandler = vi.fn(() => Promise.reject(boom));

    await expect(runPostReadyBootTail(runtime, steps)).rejects.toThrow(boom);
    // The throw short-circuits the remaining tail steps.
    expect(steps.registerAppRoutePlugins).not.toHaveBeenCalled();
  });
});
