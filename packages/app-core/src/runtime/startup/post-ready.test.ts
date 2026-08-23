/**
 * Colocated unit coverage for the post-ready boot tail. Asserts resource-slot
 * ownership, contributor ordering, superseded-runtime skip, in-flight identity
 * changes, fire-and-forget voice warmup, and deferred-boot phase stamping.
 * Drives the real module with injected step stubs; no live runtime is started.
 */
import {
  _resetDeferredBootStatusForTest,
  getDeferredBootStatus,
  markDeferredBootPhase,
} from "@elizaos/agent/runtime/deferred-boot-status";
import { type AgentRuntime, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as postReady from "./post-ready.ts";
import {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  runPostReadyBootTail,
} from "./post-ready.ts";

const STEP_ORDER = [
  "registerAppRoutePlugins",
  "registerRuntimeHooks",
  "registerCoreSensitiveRequestAdapters",
  "registerSubAgentCredentialBridgeAdapter",
  "registerSubAgentCredentialBridge",
  "ensureTriggerEventBridge",
  "ensureConnectorTargetCatalog",
  "startDeferredVoiceWarmup",
] as const;

type StepName = (typeof STEP_ORDER)[number];

const AWAITED_STEPS = [
  "registerAppRoutePlugins",
  "registerRuntimeHooks",
  "registerSubAgentCredentialBridge",
  "ensureTriggerEventBridge",
  "ensureConnectorTargetCatalog",
] as const satisfies ReadonlyArray<StepName>;

const SYNC_THROW_STEPS = [
  "registerCoreSensitiveRequestAdapters",
  "registerSubAgentCredentialBridgeAdapter",
  "startDeferredVoiceWarmup",
] as const satisfies ReadonlyArray<StepName>;

function runtimeNamed(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

function makeSteps(): {
  steps: PostReadyBootSteps;
  order: string[];
  seen: AgentRuntime[];
} {
  const order: string[] = [];
  const seen: AgentRuntime[] = [];
  const record = (name: StepName) => (runtime: AgentRuntime) => {
    order.push(name);
    seen.push(runtime);
  };
  const recordAsync = (name: StepName) => async (runtime: AgentRuntime) => {
    record(name)(runtime);
  };
  const steps: PostReadyBootSteps = {
    registerAppRoutePlugins: recordAsync("registerAppRoutePlugins"),
    registerRuntimeHooks: recordAsync("registerRuntimeHooks"),
    registerCoreSensitiveRequestAdapters: record(
      "registerCoreSensitiveRequestAdapters",
    ),
    registerSubAgentCredentialBridgeAdapter: (runtime) => {
      record("registerSubAgentCredentialBridgeAdapter")(runtime);
      return true;
    },
    registerSubAgentCredentialBridge: recordAsync(
      "registerSubAgentCredentialBridge",
    ),
    ensureTriggerEventBridge: recordAsync("ensureTriggerEventBridge"),
    ensureConnectorTargetCatalog: recordAsync("ensureConnectorTargetCatalog"),
    startDeferredVoiceWarmup: record("startDeferredVoiceWarmup"),
  };
  return { steps, order, seen };
}

describe("post-ready exports", () => {
  it("exposes only the resource factory and the boot-tail runner", () => {
    expect(Object.keys(postReady).sort()).toEqual([
      "createRuntimeBootResources",
      "runPostReadyBootTail",
    ]);
  });
});

describe("createRuntimeBootResources", () => {
  it("starts every ownership slot empty", () => {
    expect(createRuntimeBootResources()).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });

  it("returns a fresh object each call so two boots do not share slots", () => {
    const first = createRuntimeBootResources();
    const second = createRuntimeBootResources();
    expect(first).not.toBe(second);
    first.tailRuntime = runtimeNamed("first");
    first.triggerEventBridge = { stop() {} };
    first.connectorTargetCatalog = { stop() {} };
    expect(second).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });
});

describe("runPostReadyBootTail", () => {
  beforeEach(() => {
    _resetDeferredBootStatusForTest();
  });

  afterEach(() => {
    _resetDeferredBootStatusForTest();
    vi.restoreAllMocks();
  });

  it("skips every contributor when the resource slot is empty", async () => {
    const runtime = runtimeNamed("empty-slot");
    const resources = createRuntimeBootResources();
    const { steps, order } = makeSteps();
    const info = vi.spyOn(logger, "info");
    markDeferredBootPhase("app-route-tail", "pending");

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).resolves.toBeUndefined();

    expect(order).toEqual([]);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "[eliza] post-ready boot tail skipped — runtime superseded",
    );
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("pending");
    expect(resources).toEqual({
      tailRuntime: null,
      triggerEventBridge: null,
      connectorTargetCatalog: null,
    });
  });

  it("skips when the slot holds a different runtime identity", async () => {
    const live = runtimeNamed("live");
    const superseded = runtimeNamed("superseded");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = live;
    const { steps, order } = makeSteps();
    const info = vi.spyOn(logger, "info");

    await runPostReadyBootTail(superseded, steps, resources);

    expect(order).toEqual([]);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "[eliza] post-ready boot tail skipped — runtime superseded",
    );
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBeUndefined();
    expect(resources.tailRuntime).toBe(live);
  });

  it("runs every contributor in declared order for a single matching runtime", async () => {
    const runtime = runtimeNamed("owner");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps, order, seen } = makeSteps();

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).resolves.toBeUndefined();

    expect(order).toEqual([...STEP_ORDER]);
    expect(seen).toHaveLength(STEP_ORDER.length);
    expect(seen.every((value) => value === runtime)).toBe(true);
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");
    expect(resources.tailRuntime).toBe(runtime);
  });

  it("ignores a false credential-adapter return and still stamps complete", async () => {
    const runtime = runtimeNamed("adapter-false");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps, order } = makeSteps();
    steps.registerSubAgentCredentialBridgeAdapter = (received) => {
      order.push("registerSubAgentCredentialBridgeAdapter");
      expect(received).toBe(runtime);
      return false;
    };

    await runPostReadyBootTail(runtime, steps, resources);

    expect(order).toEqual([...STEP_ORDER]);
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");
  });

  it("does not await startDeferredVoiceWarmup before stamping complete", async () => {
    const runtime = runtimeNamed("voice-hang");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps, order } = makeSteps();
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hangWarmup = (): Promise<void> => {
      order.push("startDeferredVoiceWarmup");
      return hung;
    };
    steps.startDeferredVoiceWarmup =
      hangWarmup as PostReadyBootSteps["startDeferredVoiceWarmup"];

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).resolves.toBeUndefined();
    expect(order).toEqual([...STEP_ORDER]);
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");

    release();
    await hung;
  });

  it("does not reject the tail when voice warmup returns a rejected promise", async () => {
    const runtime = runtimeNamed("voice-reject");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const { steps } = makeSteps();
    const warmupFailure = Promise.reject(new Error("warmup failed"));
    const rejectWarmup = (): Promise<void> => warmupFailure;
    steps.startDeferredVoiceWarmup =
      rejectWarmup as PostReadyBootSteps["startDeferredVoiceWarmup"];

    await expect(
      runPostReadyBootTail(runtime, steps, resources),
    ).resolves.toBeUndefined();
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");
    await expect(warmupFailure).rejects.toThrow("warmup failed");
  });

  it("keeps running after the slot is swapped mid-await and still stamps complete", async () => {
    const original = runtimeNamed("original");
    const replacement = runtimeNamed("replacement");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = original;
    const { steps, order } = makeSteps();
    steps.registerAppRoutePlugins = async () => {
      order.push("registerAppRoutePlugins");
      resources.tailRuntime = replacement;
    };

    await runPostReadyBootTail(original, steps, resources);

    // The liveness check is only at entry. A swap after that still finishes
    // the remaining contributors and overwrites the phase — observed, not the
    // comment's "cannot overwrite" claim.
    expect(order).toEqual([...STEP_ORDER]);
    expect(resources.tailRuntime).toBe(replacement);
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");
  });

  it.each([...AWAITED_STEPS])(
    "short-circuits later steps when %s rejects and does not stamp complete",
    async (name) => {
      const runtime = runtimeNamed(`reject-${name}`);
      const resources = createRuntimeBootResources();
      resources.tailRuntime = runtime;
      const { steps, order } = makeSteps();
      const boom = new Error(`${name} failed`);
      markDeferredBootPhase("app-route-tail", "pending");
      steps[name] = async () => {
        order.push(name);
        throw boom;
      };

      await expect(
        runPostReadyBootTail(runtime, steps, resources),
      ).rejects.toThrow(boom);

      const failedAt = STEP_ORDER.indexOf(name);
      expect(order).toEqual(STEP_ORDER.slice(0, failedAt + 1));
      expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("pending");
    },
  );

  it.each([...SYNC_THROW_STEPS])(
    "short-circuits later steps when %s throws synchronously and does not stamp complete",
    async (name) => {
      const runtime = runtimeNamed(`throw-${name}`);
      const resources = createRuntimeBootResources();
      resources.tailRuntime = runtime;
      const { steps, order } = makeSteps();
      const boom = new Error(`${name} threw`);
      markDeferredBootPhase("app-route-tail", "pending");
      steps[name] = () => {
        order.push(name);
        throw boom;
      };

      await expect(
        runPostReadyBootTail(runtime, steps, resources),
      ).rejects.toThrow(boom);

      const failedAt = STEP_ORDER.indexOf(name);
      expect(order).toEqual(STEP_ORDER.slice(0, failedAt + 1));
      expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("pending");
    },
  );

  it("runs the full tail again when the same runtime is still the owner", async () => {
    const runtime = runtimeNamed("repeat");
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const first = makeSteps();
    const second = makeSteps();

    await runPostReadyBootTail(runtime, first.steps, resources);
    await runPostReadyBootTail(runtime, second.steps, resources);

    expect(first.order).toEqual([...STEP_ORDER]);
    expect(second.order).toEqual([...STEP_ORDER]);
    expect(getDeferredBootStatus().phases["app-route-tail"]).toBe("complete");
  });
});
