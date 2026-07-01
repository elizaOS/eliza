// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPerfHudEnabled,
  startFrameBudgetMonitor,
} from "./useFrameBudgetMonitor";
import { RENDER_TELEMETRY_EVENT } from "./useRenderGuard";

/**
 * The frame-budget monitor must be OFF unless the `__ELIZA_PERF_HUD__` dev
 * opt-in is set — it installs a permanent requestAnimationFrame loop, so it can
 * never run in production. When disabled, starting it is a no-op that emits
 * nothing on the shared telemetry channel.
 */

type PerfHudGlobal = typeof globalThis & { __ELIZA_PERF_HUD__?: boolean };

afterEach(() => {
  (globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ = undefined;
  vi.restoreAllMocks();
});

describe("isPerfHudEnabled", () => {
  it("is false without the opt-in, true once __ELIZA_PERF_HUD__ is set (in dev/test)", () => {
    (globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ = undefined;
    expect(isPerfHudEnabled()).toBe(false);
    (globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ = true;
    // render telemetry is enabled in the test env (MODE === "test").
    expect(isPerfHudEnabled()).toBe(true);
  });
});

describe("startFrameBudgetMonitor", () => {
  it("is a no-op when disabled: returns a callable stop and emits nothing", () => {
    (globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ = undefined;
    const onEvent = vi.fn();
    window.addEventListener(RENDER_TELEMETRY_EVENT, onEvent);
    const stop = startFrameBudgetMonitor();
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
    window.removeEventListener(RENDER_TELEMETRY_EVENT, onEvent);
  });

  it("when enabled, returns a stop function that tears down cleanly", () => {
    (globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ = true;
    const stop = startFrameBudgetMonitor({ windowMs: 50 });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
