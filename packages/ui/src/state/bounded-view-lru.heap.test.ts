// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BUNDLE_MODULE_MAX_ENTRIES,
  DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
  getBundleModuleMaxEntries,
  getKeepAliveMaxViews,
  getRetainedModuleMaxEntries,
  HEAP_PRESSURE_EVENT,
  HEAP_PRESSURE_RATIO,
  isCacheMemoryConstrained,
  isHeapUnderPressure,
  LOW_MEMORY_BUNDLE_MODULE_MAX_ENTRIES,
  LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS,
  LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
  readJsHeap,
  readJsHeapUsedSize,
} from "./bounded-view-lru";
import {
  __resetHeapPressureMonitorForTests,
  checkHeapPressureOnce,
} from "./heap-pressure-monitor";

const LIMIT = 1_000_000;

function setHeap(used: number | null): void {
  if (used === null) {
    // biome-ignore lint/performance/noDelete: test cleanup of the mock field
    delete (performance as { memory?: unknown }).memory;
    return;
  }
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: { usedJSHeapSize: used, jsHeapSizeLimit: LIMIT },
  });
}

function setDeviceMemory(gb: number | null): void {
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: gb === null ? undefined : gb,
  });
}

describe("bounded-view-lru live heap accounting (#10196)", () => {
  beforeEach(() => {
    setHeap(null);
    setDeviceMemory(16); // a healthy, non-low-memory device by default
  });
  afterEach(() => {
    setHeap(null);
    __resetHeapPressureMonitorForTests();
    vi.restoreAllMocks();
  });

  it("readJsHeap returns null without the API and a reading with it", () => {
    expect(readJsHeap()).toBeNull();
    expect(readJsHeapUsedSize()).toBeUndefined();
    setHeap(0.5 * LIMIT);
    expect(readJsHeap()).toEqual({
      usedJSHeapSize: 0.5 * LIMIT,
      jsHeapSizeLimit: LIMIT,
    });
    expect(readJsHeapUsedSize()).toBe(0.5 * LIMIT);
  });

  it("isHeapUnderPressure trips at the ratio, is false below and without the API", () => {
    expect(isHeapUnderPressure()).toBe(false); // no API
    setHeap((HEAP_PRESSURE_RATIO - 0.05) * LIMIT);
    expect(isHeapUnderPressure()).toBe(false);
    setHeap(HEAP_PRESSURE_RATIO * LIMIT);
    expect(isHeapUnderPressure()).toBe(true);
    setHeap(0.95 * LIMIT);
    expect(isHeapUnderPressure()).toBe(true);
  });

  it("live heap pressure constrains the caps even on a healthy device", () => {
    // Healthy device, low heap → default (large) caps.
    setHeap(0.2 * LIMIT);
    expect(isCacheMemoryConstrained()).toBe(false);
    expect(getRetainedModuleMaxEntries()).toBe(
      DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getBundleModuleMaxEntries()).toBe(DEFAULT_BUNDLE_MODULE_MAX_ENTRIES);

    // Same healthy device, but live heap is now under pressure → low-memory caps.
    setHeap(0.9 * LIMIT);
    expect(isCacheMemoryConstrained()).toBe(true);
    expect(getRetainedModuleMaxEntries()).toBe(
      LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getBundleModuleMaxEntries()).toBe(
      LOW_MEMORY_BUNDLE_MODULE_MAX_ENTRIES,
    );
    expect(getKeepAliveMaxViews()).toBe(LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS);
  });

  it("checkHeapPressureOnce dispatches the heap-pressure event only under pressure", () => {
    const fired: Event[] = [];
    const handler = (e: Event) => fired.push(e);
    document.addEventListener(HEAP_PRESSURE_EVENT, handler);
    try {
      setHeap(0.2 * LIMIT);
      expect(checkHeapPressureOnce()).toBe(false);
      expect(fired).toHaveLength(0);

      setHeap(0.95 * LIMIT);
      expect(checkHeapPressureOnce()).toBe(true);
      expect(fired).toHaveLength(1);
    } finally {
      document.removeEventListener(HEAP_PRESSURE_EVENT, handler);
    }
  });
});
