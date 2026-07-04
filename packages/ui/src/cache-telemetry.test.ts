// @vitest-environment jsdom

/**
 * Unit coverage for the module-cache eviction telemetry stream (#10196): heap-
 * pressure accounting and bounded dispatch of the eviction events emitted by
 * the retained-lazy loader. In-memory ring, no real modules.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitModuleCacheTelemetry,
  MODULE_CACHE_TELEMETRY_EVENT,
  type ModuleCacheTelemetryEvent,
} from "./cache-telemetry";

type Ring = ModuleCacheTelemetryEvent[];
type CacheGlobal = typeof globalThis & {
  __ELIZA_MODULE_CACHE_TELEMETRY__?: Ring;
  __ELIZA_MODULE_CACHE_TELEMETRY_SEQUENCE__?: number;
};

function base(): Omit<ModuleCacheTelemetryEvent, "at" | "route"> {
  return {
    source: "dynamic-view",
    action: "evict",
    reason: "lru",
    key: "k",
    activeCount: 1,
    idleCount: 2,
    cacheSize: 3,
  };
}

function install(): Ring {
  const g = globalThis as CacheGlobal;
  g.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
  return g.__ELIZA_MODULE_CACHE_TELEMETRY__;
}

describe("cache-telemetry", () => {
  afterEach(() => {
    const g = globalThis as CacheGlobal;
    delete g.__ELIZA_MODULE_CACHE_TELEMETRY__;
    delete g.__ELIZA_MODULE_CACHE_TELEMETRY_SEQUENCE__;
    delete (performance as { memory?: unknown }).memory;
  });

  it("pushes to the installed ring and stamps at + route", () => {
    const ring = install();
    emitModuleCacheTelemetry(base());
    expect(ring).toHaveLength(1);
    expect(ring[0].action).toBe("evict");
    expect(typeof ring[0].at).toBe("number");
    expect(ring[0].route).toBe(window.location.pathname);
  });

  it("is a safe no-op for the ring when not installed", () => {
    const g = globalThis as CacheGlobal;
    delete g.__ELIZA_MODULE_CACHE_TELEMETRY__;
    expect(() => emitModuleCacheTelemetry(base())).not.toThrow();
    expect(g.__ELIZA_MODULE_CACHE_TELEMETRY__).toBeUndefined();
  });

  it("dispatches the CustomEvent carrying the detail", () => {
    install();
    const handler = vi.fn();
    window.addEventListener(
      MODULE_CACHE_TELEMETRY_EVENT,
      handler as EventListener,
    );
    emitModuleCacheTelemetry({ ...base(), reason: "heap-pressure" });
    window.removeEventListener(
      MODULE_CACHE_TELEMETRY_EVENT,
      handler as EventListener,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock
      .calls[0][0] as CustomEvent<ModuleCacheTelemetryEvent>;
    expect(evt.detail.reason).toBe("heap-pressure");
  });

  it("carries the live heap fields + pressure ratio when performance.memory is present (#10196)", () => {
    (performance as { memory?: unknown }).memory = {
      usedJSHeapSize: 60_000_000,
      jsHeapSizeLimit: 100_000_000,
    };
    const ring = install();
    emitModuleCacheTelemetry({ ...base(), reason: "heap-pressure" });
    expect(ring[0].usedJSHeapSize).toBe(60_000_000);
    expect(ring[0].jsHeapSizeLimit).toBe(100_000_000);
    expect(ring[0].heapPressureRatio).toBeCloseTo(0.6, 5);
  });

  it("omits heap fields when performance.memory is absent (non-Chromium)", () => {
    delete (performance as { memory?: unknown }).memory;
    const ring = install();
    emitModuleCacheTelemetry(base());
    expect(ring[0].usedJSHeapSize).toBeUndefined();
    expect(ring[0].heapPressureRatio).toBeUndefined();
  });

  it("advances the module-cache telemetry sequence on each emit", () => {
    install();
    emitModuleCacheTelemetry(base());
    emitModuleCacheTelemetry(base());
    expect(
      (globalThis as CacheGlobal).__ELIZA_MODULE_CACHE_TELEMETRY_SEQUENCE__,
    ).toBeGreaterThanOrEqual(2);
  });
});
