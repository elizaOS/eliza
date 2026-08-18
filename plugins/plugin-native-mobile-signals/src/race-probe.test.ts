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
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        batteryCall += 1;
        if (batteryCall >= 2) {
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
