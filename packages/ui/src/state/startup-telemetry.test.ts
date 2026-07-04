// @vitest-environment jsdom
/**
 * The startup trace recorder (`startup-telemetry`): mark/measure accumulation,
 * the window-mirrored trace, and per-window trace-id isolation. jsdom; pure
 * in-memory + `window` state, no real timers or backend.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetStartupTraceForTests,
  getStartupTrace,
  hasStartupMark,
  initStartupTrace,
  markStartup,
  measureStartup,
  STARTUP_TRACE_ID_WINDOW_KEY,
  STARTUP_TRACE_WINDOW_KEY,
  type StartupTrace,
} from "./startup-telemetry";

afterEach(() => {
  __resetStartupTraceForTests();
});

function windowTrace(): StartupTrace | undefined {
  return (window as unknown as Record<string, unknown>)[
    STARTUP_TRACE_WINDOW_KEY
  ] as StartupTrace | undefined;
}

describe("startup-telemetry", () => {
  it("records checkpoints in order and mirrors them to window", () => {
    markStartup("module-eval", { platform: "web" });
    markStartup("react-mount:start");

    const trace = getStartupTrace();
    expect(trace.marks.map((m) => m.name)).toEqual([
      "module-eval",
      "react-mount:start",
    ]);
    expect(trace.marks[0]?.detail).toEqual({ platform: "web" });
    expect(typeof trace.marks[0]?.at).toBe("number");

    const mirrored = windowTrace();
    expect(mirrored?.marks.map((m) => m.name)).toEqual([
      "module-eval",
      "react-mount:start",
    ]);
    expect(mirrored?.traceId).toBe(trace.traceId);
  });

  it("dedupes by name — first occurrence wins (phase re-entry is ignored)", () => {
    markStartup("coordinator:polling-backend", { attempt: 0 });
    markStartup("coordinator:polling-backend", { attempt: 5 });

    const trace = getStartupTrace();
    expect(trace.marks).toHaveLength(1);
    expect(trace.marks[0]?.detail).toEqual({ attempt: 0 });
    expect(hasStartupMark("coordinator:polling-backend")).toBe(true);
    expect(hasStartupMark("coordinator:ready")).toBe(false);
  });

  it("adopts a native-host-injected trace id when present", () => {
    (window as unknown as Record<string, unknown>)[
      STARTUP_TRACE_ID_WINDOW_KEY
    ] = "host-abc-123";
    expect(initStartupTrace("ignored-preferred")).toBe("host-abc-123");
    expect(getStartupTrace().traceId).toBe("host-abc-123");
  });

  it("adopts the Android native bridge trace id when no window id is injected", () => {
    window.ElizaNative = {
      getStartupTraceId: () => "android-abc-123",
    };

    expect(initStartupTrace("ignored-preferred")).toBe("android-abc-123");
    expect(getStartupTrace().traceId).toBe("android-abc-123");
    expect(windowTrace()?.traceId).toBe("android-abc-123");
  });

  it("keeps the injected window trace id ahead of the Android bridge", () => {
    (window as unknown as Record<string, unknown>)[
      STARTUP_TRACE_ID_WINDOW_KEY
    ] = "host-wins";
    window.ElizaNative = {
      getStartupTraceId: () => "android-loses",
    };

    expect(initStartupTrace("ignored-preferred")).toBe("host-wins");
  });

  it("uses the preferred id when no host id is injected", () => {
    expect(initStartupTrace("renderer-xyz")).toBe("renderer-xyz");
    // Idempotent: a second call does not change the id.
    expect(initStartupTrace("other")).toBe("renderer-xyz");
  });

  it("derives a stable renderer-local id with no injected/preferred id", () => {
    const id = initStartupTrace();
    expect(id).toMatch(/^renderer-/);
    expect(getStartupTrace().traceId).toBe(id);
  });

  it("auto-initializes the trace on first mark", () => {
    markStartup("main-start");
    expect(getStartupTrace().traceId).not.toBe("");
    expect(windowTrace()?.traceId).not.toBe("");
  });

  it("measureStartup never throws when endpoint marks are missing", () => {
    expect(() => measureStartup("gap", "missing-a", "missing-b")).not.toThrow();
  });

  it("exposes timeOrigin for cross-process correlation", () => {
    markStartup("module-eval");
    expect(typeof getStartupTrace().timeOrigin).toBe("number");
  });
});
