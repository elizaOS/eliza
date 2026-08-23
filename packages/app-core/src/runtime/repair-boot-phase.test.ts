/**
 * Unit coverage for the post-ready boot tail phase split:
 * `getDeferAppRoutesEnabled` (deferred-by-default; explicit falsy tokens opt out) and
 * `runPostReadyBootTail`, which runs the post-ready-safe boot steps — TTS, app
 * routes, runtime hooks, sensitive-request adapters, credential bridge, trigger
 * bridge, connector catalog, voice warmup — in declared order. Tests drive
 * injected step stubs to assert step ordering, deferred-mode dispatch (the caller
 * returns before a hung app-route load settles), the superseded-runtime teardown
 * guard, and per-step error isolation.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDeferAppRoutesEnabled } from "./startup/app-contributors.ts";
import {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  runPostReadyBootTail,
} from "./startup/post-ready.ts";

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
  it("defers by default; only explicit falsy tokens opt back into the inline tail", () => {
    // Deferred is the default: unset / empty / truthy values all defer.
    expect(getDeferAppRoutesEnabled({})).toBe(true);
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "1" })).toBe(
      true,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "  1  " })).toBe(
      true,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "true" })).toBe(
      true,
    );
    // Explicit opt-out tokens await the tail inline before ready.
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "0" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: " 0 " })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "false" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "FALSE" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "no" })).toBe(
      false,
    );
    expect(getDeferAppRoutesEnabled({ ELIZA_DEFER_APP_ROUTES: "off" })).toBe(
      false,
    );
  });
});

describe("runPostReadyBootTail — phase split", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(default-unset ordering) awaits every tail step in declared order", async () => {
    const runtime = makeFakeRuntime();
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps, order } = makeSteps();

    await runPostReadyBootTail(runtime, steps, resources);

    // ensureLocalInferenceHandler + autonomy are PRE-ready (inline in
    // repairRuntimeAfterBoot) and intentionally absent from the tail; the tail
    // owns exactly these post-ready-safe steps, in this order.
    expect(order).toEqual([
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
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
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
    const tail = runPostReadyBootTail(runtime, steps, resources).then(() => {
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
    const resources = createRuntimeBootResources();
    resources.tailRuntime = liveRuntime;
    const { steps, order } = makeSteps();

    await runPostReadyBootTail(supersededRuntime, steps, resources);

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
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps } = makeSteps();
    // registerAppRoutePlugins isolates per-loader failures internally and
    // resolves (never rejects), so the tail completes normally.
    steps.registerAppRoutePlugins = vi.fn(() => Promise.resolve());

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).resolves.toBeUndefined();
    expect(steps.ensureConnectorTargetCatalog).toHaveBeenCalledOnce();
  });

  it("(error isolation) a throwing runtime hook rejects the tail", async () => {
    const runtime = makeFakeRuntime();
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps } = makeSteps();
    const boom = new Error("runtime hook registration failed");
    steps.registerRuntimeHooks = vi.fn(() => Promise.reject(boom));

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).rejects.toThrow(boom);
    // The throw short-circuits the remaining tail steps.
    expect(steps.registerCoreSensitiveRequestAdapters).not.toHaveBeenCalled();
  });

  it("(mid-tail teardown) the started contributor finishes but later contributors and the completion stamp do not run (#25110)", async () => {
    const runtime = makeFakeRuntime();
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps, order } = makeSteps();

    // Hold the FIRST contributor open, exactly like a slow app-route load.
    let releaseAppRoutes!: () => void;
    const appRoutesGate = new Promise<void>((resolve) => {
      releaseAppRoutes = resolve;
    });
    steps.registerAppRoutePlugins = vi.fn(() => {
      order.push("appRoutes");
      return appRoutesGate;
    });

    let tailSettled = false;
    const tail = runPostReadyBootTail(runtime, steps, resources).then(() => {
      tailSettled = true;
    });

    // While the first contributor is awaiting, teardown clears ownership —
    // the same thing stopRuntimeBootResources does during shutdown/hot restart.
    await Promise.resolve();
    resources.tailRuntime = null;

    releaseAppRoutes();
    await tail;

    // The already-started contributor was allowed to finish...
    expect(order).toEqual(["appRoutes"]);
    // ...but nothing after it ran: no hooks, no bridges, no catalog, no
    // warmup, and no completion stamp for a stopped runtime's work.
    expect(steps.registerRuntimeHooks).not.toHaveBeenCalled();
    expect(steps.ensureTriggerEventBridge).not.toHaveBeenCalled();
    expect(steps.ensureConnectorTargetCatalog).not.toHaveBeenCalled();
    expect(steps.startDeferredVoiceWarmup).not.toHaveBeenCalled();
    expect(tailSettled).toBe(true);
  });

  it("(mid-tail ownership transfer) a superseding boot attempt stops the old tail before its remaining contributors", async () => {
    const oldRuntime = makeFakeRuntime();
    const liveRuntime = makeFakeRuntime();
    const resources = createRuntimeBootResources();
    resources.tailRuntime = oldRuntime;
    const { steps, order } = makeSteps();

    let releaseCredentialBridge!: () => void;
    const credentialGate = new Promise<void>((resolve) => {
      releaseCredentialBridge = resolve;
    });
    steps.registerSubAgentCredentialBridge = vi.fn(() => {
      order.push("credentialBridgeWiring");
      return credentialGate;
    });

    const tail = runPostReadyBootTail(oldRuntime, steps, resources);

    // Hot restart publishes the newer runtime into the same resource slot.
    await Promise.resolve();
    resources.tailRuntime = liveRuntime;

    releaseCredentialBridge();
    await tail;

    // The synchronous sensitive/adapter registrations and the gated bridge
    // call sit behind the same microtask queue as the ownership re-check, so
    // once the newer runtime is published the old tail stops before them.
    expect(order).toEqual(["appRoutes", "runtimeHooks"]);
    expect(steps.registerCoreSensitiveRequestAdapters).not.toHaveBeenCalled();
    expect(steps.ensureTriggerEventBridge).not.toHaveBeenCalled();
    expect(steps.ensureConnectorTargetCatalog).not.toHaveBeenCalled();
  });
});
