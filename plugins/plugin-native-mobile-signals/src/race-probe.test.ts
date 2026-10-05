/** Exercises real monitoring teardown across controlled pending battery reads and DOM events. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileSignalsWeb } from "./web";

const cleanups: Array<() => Promise<void>> = [];

function fixture(pendingRead = 0) {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let reads = 0;
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0",
    getBattery: async () => {
      if (++reads === pendingRead) {
        markEntered();
        await gate;
      }
      return { charging: true, level: 0.5 };
    },
  });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", undefined);
  const plugin = new MobileSignalsWeb();
  const listener = vi.fn();
  cleanups.push(async () => {
    release();
    await plugin.stopMonitoring();
    await plugin.removeAllListeners();
  });
  return { plugin, listener, document, entered, release };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MobileSignalsWeb teardown race", () => {
  it.each([false, true])(
    "suppresses a pending event after stop (restart=%s)",
    async (restart) => {
      const { plugin, listener, document, entered, release } = fixture(2);
      await plugin.addListener("signal", listener);
      await plugin.startMonitoring({ emitInitial: false });
      document.dispatchEvent(new Event("visibilitychange"));
      await entered;

      await plugin.stopMonitoring();
      if (restart) await plugin.startMonitoring({ emitInitial: false });
      release();
      // The event callback is intentionally fire-and-forget; drain its resumed microtasks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it("does not leak the initial pair when stopped mid-start", async () => {
    const { plugin, listener, entered, release } = fixture(1);
    await plugin.addListener("signal", listener);
    const start = plugin.startMonitoring({ emitInitial: true });
    await entered;
    await plugin.stopMonitoring();
    release();

    expect((await start).enabled).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers a fresh initial pair after stop and restart", async () => {
    const { plugin, listener } = fixture();
    await plugin.addListener("signal", listener);
    await plugin.startMonitoring({ emitInitial: false });
    await plugin.stopMonitoring();
    expect(listener).not.toHaveBeenCalled();

    expect((await plugin.startMonitoring({ emitInitial: true })).enabled).toBe(
      true,
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
