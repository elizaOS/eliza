// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
  type LayoutShiftTelemetryEvent,
  startLayoutShiftMonitor,
} from "./useLayoutShiftMonitor";
import { RENDER_TELEMETRY_EVENT } from "./useRenderGuard";

type MockPerformanceObserverCallback = (
  list: PerformanceObserverEntryList,
) => void;

type LayoutShiftTestEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{ node?: Node | null }>;
};

type RenderTelemetryGlobal = typeof globalThis & {
  __ELIZA_RENDER_TELEMETRY__?: unknown[];
};

function shift(
  value: number,
  hadRecentInput = false,
  sources?: Array<{ node?: Node | null }>,
): LayoutShiftTestEntry {
  return {
    name: "layout-shift",
    entryType: "layout-shift",
    startTime: 0,
    duration: 0,
    value,
    hadRecentInput,
    ...(sources ? { sources } : {}),
    toJSON: () => ({}),
  };
}

function entryList(
  entries: LayoutShiftTestEntry[],
): PerformanceObserverEntryList {
  return {
    getEntries: () => entries,
    getEntriesByName: () => [],
    getEntriesByType: () => [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
  delete (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__;
});

describe("startLayoutShiftMonitor", () => {
  it("emits flagged layout-shift telemetry on the shared channel", () => {
    vi.useFakeTimers();
    const telemetry: unknown[] = [];
    (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__ =
      telemetry;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const eventListener = vi.fn();
    window.addEventListener(RENDER_TELEMETRY_EVENT, eventListener);

    let callback: MockPerformanceObserverCallback = () => {
      throw new Error("PerformanceObserver callback was not installed");
    };
    const disconnect = vi.fn();
    const observe = vi.fn();
    class MockPerformanceObserver {
      constructor(cb: MockPerformanceObserverCallback) {
        callback = cb;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

    const stop = startLayoutShiftMonitor({
      windowMs: 100,
      clsBudget: 0.1,
    });

    expect(observe).toHaveBeenCalledWith({
      type: "layout-shift",
      buffered: false,
    });

    callback(entryList([shift(0.07), shift(0.05), shift(0.3, true)]));
    vi.advanceTimersByTime(100);

    const event = telemetry[0] as LayoutShiftTelemetryEvent;
    expect(event).toMatchObject({
      source: "layoutShift",
      severity: "error",
      cls: 0.12000000000000001,
      shiftCount: 2,
      largestShift: 0.07,
      windowMs: 100,
    });
    expect(eventListener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[RenderTelemetry] layout shifted 2x (CLS 0.120) within 100ms",
      event,
    );

    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    window.removeEventListener(RENDER_TELEMETRY_EVENT, eventListener);
  });

  it("does not emit healthy windows unless requested", () => {
    vi.useFakeTimers();
    const telemetry: unknown[] = [];
    (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__ =
      telemetry;

    let callback: MockPerformanceObserverCallback = () => {
      throw new Error("PerformanceObserver callback was not installed");
    };
    class MockPerformanceObserver {
      constructor(cb: MockPerformanceObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

    const stop = startLayoutShiftMonitor({
      windowMs: 100,
      clsBudget: 0.1,
    });

    callback(entryList([shift(0.03)]));
    vi.advanceTimersByTime(100);

    expect(telemetry).toEqual([]);
    stop();
  });

  it("ignores shifts fully attributed to an intentional transient-motion subtree", () => {
    vi.useFakeTimers();
    const telemetry: unknown[] = [];
    (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__ =
      telemetry;

    let callback: MockPerformanceObserverCallback = () => {
      throw new Error("PerformanceObserver callback was not installed");
    };
    class MockPerformanceObserver {
      constructor(cb: MockPerformanceObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

    const surface = document.createElement("div");
    surface.setAttribute(
      LAYOUT_SHIFT_INTENT_ATTR,
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );
    const child = document.createElement("div");
    surface.appendChild(child);
    document.body.appendChild(surface);

    const stop = startLayoutShiftMonitor({
      windowMs: 100,
      clsBudget: 0.1,
    });

    callback(entryList([shift(0.3, false, [{ node: child }])]));
    vi.advanceTimersByTime(100);

    expect(telemetry).toEqual([]);
    stop();
  });

  it("still reports mixed intentional and outside shifts", () => {
    vi.useFakeTimers();
    const telemetry: unknown[] = [];
    (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__ =
      telemetry;
    vi.spyOn(console, "error").mockImplementation(() => {});

    let callback: MockPerformanceObserverCallback = () => {
      throw new Error("PerformanceObserver callback was not installed");
    };
    class MockPerformanceObserver {
      constructor(cb: MockPerformanceObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

    const surface = document.createElement("div");
    surface.setAttribute(
      LAYOUT_SHIFT_INTENT_ATTR,
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );
    const child = document.createElement("div");
    surface.appendChild(child);
    const outside = document.createElement("div");
    document.body.append(surface, outside);

    const stop = startLayoutShiftMonitor({
      windowMs: 100,
      clsBudget: 0.1,
    });

    callback(
      entryList([shift(0.3, false, [{ node: child }, { node: outside }])]),
    );
    vi.advanceTimersByTime(100);

    const event = telemetry[0] as LayoutShiftTelemetryEvent;
    expect(event).toMatchObject({
      source: "layoutShift",
      severity: "error",
      cls: 0.3,
      shiftCount: 1,
    });
    stop();
  });

  it("attributes a coalesced window to the route where each shift was observed", () => {
    vi.useFakeTimers();
    const telemetry: unknown[] = [];
    (globalThis as RenderTelemetryGlobal).__ELIZA_RENDER_TELEMETRY__ =
      telemetry;
    vi.spyOn(console, "error").mockImplementation(() => {});

    let callback: MockPerformanceObserverCallback = () => {
      throw new Error("PerformanceObserver callback was not installed");
    };
    class MockPerformanceObserver {
      constructor(cb: MockPerformanceObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

    window.history.pushState(null, "", "/apps/logs");
    const stop = startLayoutShiftMonitor({
      windowMs: 100,
      clsBudget: 0.1,
    });

    callback(entryList([shift(0.12)]));
    window.history.pushState(null, "", "/settings");
    callback(entryList([shift(0.13)]));
    vi.advanceTimersByTime(100);

    expect(telemetry).toHaveLength(2);
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "layoutShift",
          severity: "error",
          cls: 0.12,
          route: "/apps/logs",
        }),
        expect.objectContaining({
          source: "layoutShift",
          severity: "error",
          cls: 0.13,
          route: "/settings",
        }),
      ]),
    );
    stop();
  });
});
