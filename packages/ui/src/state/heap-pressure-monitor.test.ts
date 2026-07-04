// @vitest-environment jsdom

/**
 * The JS-heap-pressure monitor (`heap-pressure-monitor`): its poll loop reads
 * `performance.memory` and emits `HEAP_PRESSURE_EVENT` past the threshold.
 * jsdom with fake timers and a stubbed `performance.memory` — deterministic, no
 * real heap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAP_PRESSURE_EVENT } from "./bounded-view-lru";
import {
  __resetHeapPressureMonitorForTests,
  checkHeapPressureOnce,
  HEAP_PRESSURE_POLL_MS,
  installHeapPressureMonitor,
} from "./heap-pressure-monitor";

function setHeap(usedJSHeapSize: number, jsHeapSizeLimit = 1000): void {
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: { usedJSHeapSize, jsHeapSizeLimit },
  });
}

function clearHeap(): void {
  delete (performance as { memory?: unknown }).memory;
}

describe("heap-pressure-monitor", () => {
  afterEach(() => {
    __resetHeapPressureMonitorForTests();
    clearHeap();
    vi.useRealTimers();
  });

  it("dispatches HEAP_PRESSURE_EVENT once when usage crosses the ratio", () => {
    setHeap(950); // 0.95 ratio >= 0.8
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    expect(checkHeapPressureOnce()).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });

  it("does not dispatch when usage is below the ratio", () => {
    setHeap(500); // 0.5 ratio < 0.8
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    expect(checkHeapPressureOnce()).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });

  it("is a no-op on engines without performance.memory", () => {
    clearHeap();
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    expect(checkHeapPressureOnce()).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });

  it("checks immediately on install when the tab boots already under pressure", () => {
    setHeap(900);
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    installHeapPressureMonitor();
    expect(onEvent).toHaveBeenCalledTimes(1);
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });

  it("polls on an interval while visible and stops after teardown", () => {
    vi.useFakeTimers();
    setHeap(500); // start below threshold so install doesn't dispatch
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    installHeapPressureMonitor();
    expect(onEvent).not.toHaveBeenCalled();

    setHeap(900); // cross the threshold
    vi.advanceTimersByTime(HEAP_PRESSURE_POLL_MS);
    expect(onEvent).toHaveBeenCalledTimes(1);

    __resetHeapPressureMonitorForTests();
    vi.advanceTimersByTime(HEAP_PRESSURE_POLL_MS * 3);
    expect(onEvent).toHaveBeenCalledTimes(1); // no more ticks after teardown
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });

  it("install is idempotent — a second install does not add a second poll loop", () => {
    vi.useFakeTimers();
    setHeap(500);
    const onEvent = vi.fn();
    document.addEventListener(HEAP_PRESSURE_EVENT, onEvent);
    installHeapPressureMonitor();
    installHeapPressureMonitor();

    setHeap(900);
    vi.advanceTimersByTime(HEAP_PRESSURE_POLL_MS);
    // One shared timer → one dispatch per tick, not two.
    expect(onEvent).toHaveBeenCalledTimes(1);
    document.removeEventListener(HEAP_PRESSURE_EVENT, onEvent);
  });
});
