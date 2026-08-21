/**
 * Regression harness for the web-fallback teardown race in MobileSignalsWeb.
 *
 * Deterministically reproduces the case where a DOM visibility event starts an
 * emit, the consumer calls stopMonitoring() while the battery read is still
 * pending, and the emit later resumes. The plugin contract is that no "signal"
 * is delivered once monitoring has stopped, so these tests gate the second
 * getBattery() call behind a manual promise to drive the exact interleaving
 * without a real browser or device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileSignalsWeb } from "./web";

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

interface CapturedDocument {
  handlers: Map<string, EventListener>;
  document: Partial<Document>;
}

function setCapturingDocument(): CapturedDocument {
  const handlers = new Map<string, EventListener>();
  const document: Partial<Document> = {
    visibilityState: "visible",
    hasFocus: vi.fn(() => true),
    addEventListener: vi.fn(
      (type: string, handler: EventListenerOrEventListenerObject) => {
        handlers.set(type, handler as EventListener);
      },
    ) as Document["addEventListener"],
    removeEventListener: vi.fn((type: string) => {
      handlers.delete(type);
    }) as Document["removeEventListener"],
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  return { handlers, document };
}

describe("MobileSignalsWeb teardown race", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not deliver a signal that started before stopMonitoring resolved", async () => {
    let releaseSecondBattery: (() => void) | undefined;
    const secondBatteryGate = new Promise<void>((resolve) => {
      releaseSecondBattery = () => resolve();
    });
    let batteryCall = 0;
    let secondBatteryEntered = false;
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        batteryCall += 1;
        if (batteryCall >= 2) {
          // Mark that the gated event-driven read actually started before we
          // await, so the test proves the interleave it claims to reproduce
          // rather than passing because the read never entered the race window.
          secondBatteryEntered = true;
          await secondBatteryGate;
        }
        return { charging: true, level: 0.5 };
      }),
    } as Partial<Navigator>);
    const { handlers } = setCapturingDocument();

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    // Initial snapshot read (getBattery #1) resolves immediately.
    await plugin.startMonitoring({ emitInitial: false });
    expect(listener).not.toHaveBeenCalled();

    const visibilityHandler = handlers.get("visibilitychange");
    expect(visibilityHandler).toBeTypeOf("function");

    // Fire the DOM event: emitSignal begins and awaits getBattery #2 (gated).
    (visibilityHandler as EventListener)(new Event("visibilitychange"));
    // Let the synchronous-through-first-await portion run so the gated read is
    // in-flight, then confirm we are genuinely inside the race window.
    await Promise.resolve();
    expect(secondBatteryEntered).toBe(true);

    // Consumer stops monitoring while the battery read is still pending.
    await plugin.stopMonitoring();

    // Now let the in-flight battery read resolve and emitSignal resume.
    releaseSecondBattery?.();
    // Drain every microtask in the resume chain (getBattery -> snapshot ->
    // notifyListeners) plus a macrotask, so a leaked emit would already have
    // fired synchronously by the time we assert.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Contract: stopMonitoring() means no further signal delivery.
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not deliver an old-session emit after a stop->restart interleave", async () => {
    let releaseSecondBattery: (() => void) | undefined;
    const secondBatteryGate = new Promise<void>((resolve) => {
      releaseSecondBattery = () => resolve();
    });
    let batteryCall = 0;
    let secondBatteryEntered = false;
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        batteryCall += 1;
        // Only the event-driven read (#2) is gated; the two startMonitoring
        // snapshot reads (#1 and #3) resolve immediately so the restart can
        // complete while the old-session emit is parked.
        if (batteryCall === 2) {
          secondBatteryEntered = true;
          await secondBatteryGate;
        }
        return { charging: true, level: 0.5 };
      }),
    } as Partial<Navigator>);
    const { handlers } = setCapturingDocument();

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    // Session 1 (getBattery #1).
    await plugin.startMonitoring({ emitInitial: false });
    const visibilityHandler = handlers.get("visibilitychange");
    expect(visibilityHandler).toBeTypeOf("function");

    // Session 1 event-driven emit begins and parks on getBattery #2.
    (visibilityHandler as EventListener)(new Event("visibilitychange"));
    await Promise.resolve();
    expect(secondBatteryEntered).toBe(true);

    // Stop, then start a fresh session 2 (getBattery #3) while the old emit is
    // still parked. `monitoring` is true again, so only a per-session token can
    // reject the resuming old-session emit.
    await plugin.stopMonitoring();
    await plugin.startMonitoring({ emitInitial: false });

    // Resume the parked session-1 emit.
    releaseSecondBattery?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The old-session snapshot must not be delivered under the new session.
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not leak the initial pair when stopMonitoring resolves mid-start", async () => {
    let releaseFirstBattery: (() => void) | undefined;
    const firstBatteryGate = new Promise<void>((resolve) => {
      releaseFirstBattery = () => resolve();
    });
    let batteryCall = 0;
    let firstBatteryEntered = false;
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        batteryCall += 1;
        if (batteryCall === 1) {
          firstBatteryEntered = true;
          await firstBatteryGate;
        }
        return { charging: true, level: 0.5 };
      }),
    } as Partial<Navigator>);
    setCapturingDocument();

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    // startMonitoring parks on its initial getBattery read.
    const startPromise = plugin.startMonitoring({ emitInitial: true });
    await Promise.resolve();
    expect(firstBatteryEntered).toBe(true);

    // Consumer stops monitoring while the initial read is pending.
    await plugin.stopMonitoring();

    // Resume the initial read.
    releaseFirstBattery?.();
    const result = await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No initial signal leaks after a resolved stop, and the return value must
    // not claim the session is enabled when it delivered nothing.
    expect(listener).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });

  it("delivers a fresh initial pair after a stop->restart (no over-suppression)", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => ({ charging: true, level: 0.5 })),
    } as Partial<Navigator>);
    setCapturingDocument();

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    // Session 1 bumps the generation to 1, then tears down.
    await plugin.startMonitoring({ emitInitial: false });
    await plugin.stopMonitoring();
    expect(listener).not.toHaveBeenCalled();

    // Session 2 runs under generation 2. The per-session token must reject a
    // stale session's emit but must NOT suppress the current session, so the
    // fresh initial pair still delivers exactly two signals.
    const result = await plugin.startMonitoring({ emitInitial: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(result.enabled).toBe(true);
  });

  it("still delivers exactly the two initial signals on the normal path", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => ({ charging: true, level: 0.5 })),
    } as Partial<Navigator>);
    setCapturingDocument();

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    await plugin.startMonitoring({ emitInitial: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
