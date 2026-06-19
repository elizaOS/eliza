/**
 * WS3 ↔ WS4 cross-plugin integration: plugin-vision's
 * `resolveArbiterFromRuntime` must discover the WS1 `MemoryArbiter`
 * (from `@elizaos/plugin-local-inference`) through the registered
 * `localInferenceLoader` runtime service and adapt it to the
 * `IModelArbiter` contract so memory-pressure events cascade into vision
 * sub-service release.
 *
 * Until this seam existed, plugin-vision's lifecycle manager could only
 * see arbiters that were explicitly published as `MEMORY_ARBITER` runtime
 * services — which nothing in the production wiring does. The WS1
 * arbiter exposes pressure via `onEvent({ type: 'memory_pressure', ... })`
 * rather than a per-holder `onPressure(handlers[])`; the bridge in
 * `lifecycle.ts#adaptWS1ArbiterToIModelArbiter` is what closes the gap.
 *
 * The test stubs the WS1 arbiter's `onEvent` surface and asserts:
 *   1. `resolveArbiterFromRuntime` returns a non-null adapter when only
 *      the loader service exposes `getMemoryArbiter()`.
 *   2. Firing a `memory_pressure` event on the WS1-arbiter side propagates
 *      to vision sub-services and releases them.
 *   3. `nominal` events do NOT trigger release (they're the "all clear"
 *      signal in the WS1 contract).
 */

import { describe, expect, it, vi } from "vitest";
import {
  resolveArbiterFromRuntime,
  VisionServiceLifecycleManager,
} from "./lifecycle";

interface WS1Event {
  type: string;
  level?: string;
}

function makeWS1ArbiterStub() {
  let listener: ((event: WS1Event) => void) | null = null;
  const onEvent = vi.fn((cb: (event: WS1Event) => void) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  return {
    arbiter: { onEvent } as unknown as {
      onEvent: (cb: (event: WS1Event) => void) => () => void;
    },
    fire(event: WS1Event) {
      listener?.(event);
    },
  };
}

describe("plugin-vision ↔ WS1 MemoryArbiter bridge", () => {
  it("discovers WS1 arbiter through localInferenceLoader.getMemoryArbiter()", () => {
    const { arbiter: ws1 } = makeWS1ArbiterStub();
    const loader = { getMemoryArbiter: () => ws1 };
    const runtime = {
      getService: (name: string) =>
        name === "localInferenceLoader" ? loader : null,
    };
    const adapted = resolveArbiterFromRuntime(runtime);
    expect(adapted).not.toBeNull();
    // The adapter satisfies the IModelArbiter contract.
    expect(typeof adapted?.acquire).toBe("function");
    expect(typeof adapted?.release).toBe("function");
    expect(typeof adapted?.onPressure).toBe("function");
  });

  it("returns null when neither MEMORY_ARBITER nor a loader is present", () => {
    const runtime = { getService: () => null };
    expect(resolveArbiterFromRuntime(runtime)).toBeNull();
  });

  it("prefers the direct MEMORY_ARBITER service over the loader bridge", () => {
    const directArbiter = {
      acquire: vi.fn(),
      release: vi.fn(),
      onPressure: vi.fn(() => () => {}),
    };
    const { arbiter: ws1 } = makeWS1ArbiterStub();
    const loader = { getMemoryArbiter: () => ws1 };
    const runtime = {
      getService: (name: string) => {
        if (name === "MEMORY_ARBITER") return directArbiter;
        if (name === "localInferenceLoader") return loader;
        return null;
      },
    };
    // Same object reference — the direct path wins.
    expect(resolveArbiterFromRuntime(runtime)).toBe(directArbiter);
  });

  it("cascades a WS1 memory_pressure low event into vision sub-service release", async () => {
    const { arbiter: ws1, fire } = makeWS1ArbiterStub();
    const loader = { getMemoryArbiter: () => ws1 };
    const runtime = {
      getService: (name: string) =>
        name === "localInferenceLoader" ? loader : null,
    };
    const adapted = resolveArbiterFromRuntime(runtime);
    expect(adapted).not.toBeNull();

    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 60_000,
      watchdogIntervalMs: 1_000_000,
    });
    mgr.attachArbiter(adapted);
    const yoloUnload = vi.fn();
    const ocrUnload = vi.fn();
    mgr.register({
      id: "vision:yolo",
      memoryBytes: 60 * 1024 * 1024,
      unload: yoloUnload,
    });
    mgr.register({
      id: "vision:ocr",
      memoryBytes: 80 * 1024 * 1024,
      unload: ocrUnload,
    });

    fire({ type: "memory_pressure", level: "low" });
    await new Promise((r) => setImmediate(r));

    // With empty named-holders, lifecycle's handlePressure releases all
    // loaded subs (coldest first). Both should drop.
    expect(yoloUnload).toHaveBeenCalledTimes(1);
    expect(ocrUnload).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it("ignores nominal-level events (only low/critical trigger cascade)", async () => {
    const { arbiter: ws1, fire } = makeWS1ArbiterStub();
    const loader = { getMemoryArbiter: () => ws1 };
    const runtime = {
      getService: (name: string) =>
        name === "localInferenceLoader" ? loader : null,
    };
    const adapted = resolveArbiterFromRuntime(runtime);
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 60_000,
      watchdogIntervalMs: 1_000_000,
    });
    mgr.attachArbiter(adapted);
    const unload = vi.fn();
    mgr.register({
      id: "vision:yolo",
      memoryBytes: 60 * 1024 * 1024,
      unload,
    });

    fire({ type: "memory_pressure", level: "nominal" });
    fire({ type: "model_load", level: undefined });
    await new Promise((r) => setImmediate(r));

    expect(unload).not.toHaveBeenCalled();
    await mgr.stop();
  });

  it("cascades critical pressure to release all loaded sub-services", async () => {
    const { arbiter: ws1, fire } = makeWS1ArbiterStub();
    const loader = { getMemoryArbiter: () => ws1 };
    const runtime = {
      getService: (name: string) =>
        name === "localInferenceLoader" ? loader : null,
    };
    const adapted = resolveArbiterFromRuntime(runtime);
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 60_000,
      watchdogIntervalMs: 1_000_000,
    });
    mgr.attachArbiter(adapted);
    const yoloUnload = vi.fn();
    const ocrUnload = vi.fn();
    const faceUnload = vi.fn();
    mgr.register({
      id: "vision:yolo",
      memoryBytes: 60 * 1024 * 1024,
      unload: yoloUnload,
    });
    mgr.register({
      id: "vision:ocr",
      memoryBytes: 80 * 1024 * 1024,
      unload: ocrUnload,
    });
    mgr.register({
      id: "vision:face",
      memoryBytes: 200 * 1024 * 1024,
      unload: faceUnload,
    });

    fire({ type: "memory_pressure", level: "critical" });
    await new Promise((r) => setImmediate(r));

    expect(yoloUnload).toHaveBeenCalledTimes(1);
    expect(ocrUnload).toHaveBeenCalledTimes(1);
    expect(faceUnload).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });
});
