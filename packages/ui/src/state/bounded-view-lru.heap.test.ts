/**
 * Live JS-heap-pressure tiering for the bounded view caches (#10196 item 2).
 *
 * The caches previously sized only off the static `navigator.deviceMemory` hint;
 * a roomy device whose live heap was near its limit kept the larger caps. These
 * tests pin the new behavior: a near-limit `performance.memory.usedJSHeapSize`
 * drops every bounded cache to its conservative tier even on a high-RAM device,
 * and the live heap reading rides along on every module-cache-telemetry event so
 * a soak can read it.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  emitModuleCacheTelemetry,
  type ModuleCacheTelemetryEvent,
} from "../cache-telemetry";
import {
  DEFAULT_KEEP_ALIVE_MAX_VIEWS,
  DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
  DEFAULT_RETAINED_MODULE_TTL_MS,
  getHeapPressureRatio,
  getKeepAliveMaxViews,
  getRetainedModuleMaxEntries,
  getRetainedModuleTtlMs,
  isHeapUnderPressure,
  isUnderMemoryPressure,
  LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS,
  LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
  LOW_MEMORY_RETAINED_MODULE_TTL_MS,
  resolveHeapUsage,
} from "./bounded-view-lru";

function setHeap(usedJSHeapSize: number | null, jsHeapSizeLimit = 100): void {
  if (usedJSHeapSize === null) {
    Object.defineProperty(performance, "memory", {
      value: undefined,
      configurable: true,
    });
    return;
  }
  Object.defineProperty(performance, "memory", {
    value: { usedJSHeapSize, jsHeapSizeLimit },
    configurable: true,
  });
}

function setDeviceMemory(gb: number | undefined): void {
  Object.defineProperty(navigator, "deviceMemory", {
    value: gb,
    configurable: true,
  });
}

afterEach(() => {
  setHeap(null);
  setDeviceMemory(undefined);
  const g = globalThis as { __ELIZA_MODULE_CACHE_TELEMETRY__?: unknown };
  g.__ELIZA_MODULE_CACHE_TELEMETRY__ = undefined;
});

describe("live JS-heap pressure tiering (#10196)", () => {
  it("resolveHeapUsage returns null when performance.memory is absent", () => {
    setHeap(null);
    expect(resolveHeapUsage()).toBeNull();
    expect(getHeapPressureRatio()).toBeNull();
    expect(isHeapUnderPressure()).toBe(false);
  });

  it("computes the heap fill ratio and flags pressure at/above 0.8", () => {
    setHeap(79, 100);
    expect(getHeapPressureRatio()).toBeCloseTo(0.79);
    expect(isHeapUnderPressure()).toBe(false);

    setHeap(80, 100);
    expect(getHeapPressureRatio()).toBeCloseTo(0.8);
    expect(isHeapUnderPressure()).toBe(true);

    setHeap(96, 100);
    expect(isHeapUnderPressure()).toBe(true);
  });

  it("a near-limit heap pressures a ROOMY device (the #10196 gap)", () => {
    setDeviceMemory(16); // not a low-memory device by the static hint
    setHeap(20, 100); // but heap is comfortable
    expect(isUnderMemoryPressure()).toBe(false);
    expect(getRetainedModuleMaxEntries()).toBe(
      DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getRetainedModuleTtlMs()).toBe(DEFAULT_RETAINED_MODULE_TTL_MS);
    expect(getKeepAliveMaxViews()).toBe(DEFAULT_KEEP_ALIVE_MAX_VIEWS);

    setHeap(90, 100); // heap now near its limit on the SAME roomy device
    expect(isUnderMemoryPressure()).toBe(true);
    expect(getRetainedModuleMaxEntries()).toBe(
      LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getRetainedModuleTtlMs()).toBe(LOW_MEMORY_RETAINED_MODULE_TTL_MS);
    expect(getKeepAliveMaxViews()).toBe(LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS);
  });

  it("a low-memory device still tiers down with no heap hint (unchanged path)", () => {
    setDeviceMemory(2);
    setHeap(null);
    expect(isUnderMemoryPressure()).toBe(true);
    expect(getRetainedModuleMaxEntries()).toBe(
      LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
    );
  });

  it("emits the live heap reading on every module-cache-telemetry event", () => {
    const events: ModuleCacheTelemetryEvent[] = [];
    (
      globalThis as {
        __ELIZA_MODULE_CACHE_TELEMETRY__?: ModuleCacheTelemetryEvent[];
      }
    ).__ELIZA_MODULE_CACHE_TELEMETRY__ = events;

    setHeap(85, 100);
    emitModuleCacheTelemetry({
      source: "dynamic-view",
      action: "evict",
      reason: "memorypressure",
      activeCount: 1,
      idleCount: 0,
      cacheSize: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0].usedJSHeapSize).toBe(85);
    expect(events[0].jsHeapSizeLimit).toBe(100);
    expect(events[0].heapPressureRatio).toBeCloseTo(0.85);
  });

  it("omits heap fields when performance.memory is absent (Safari/Firefox)", () => {
    const events: ModuleCacheTelemetryEvent[] = [];
    (
      globalThis as {
        __ELIZA_MODULE_CACHE_TELEMETRY__?: ModuleCacheTelemetryEvent[];
      }
    ).__ELIZA_MODULE_CACHE_TELEMETRY__ = events;

    setHeap(null);
    emitModuleCacheTelemetry({
      source: "retained-lazy",
      action: "load",
      activeCount: 1,
      idleCount: 0,
      cacheSize: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0].usedJSHeapSize).toBeUndefined();
    expect(events[0].heapPressureRatio).toBeUndefined();
  });
});
