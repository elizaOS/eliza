/**
 * Regression test (#12030 item 4): an iOS Keyboard-bridge throw inside
 * `createMobileLifecycle().initializeKeyboard()` must be swallowed + logged and
 * still resolve, so a pod/plugin skew cannot strand the awaited lifecycle
 * bootstrap. jsdom harness; `@capacitor/keyboard` is mocked to throw on
 * setResizeMode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileLifecycle } from "./mobile-lifecycle";

// Regression for #12030 item 4. `initializeKeyboard` ran its iOS setup
// (`await Keyboard.setResizeMode(...)` etc.) unguarded, unlike the sibling
// `initializeStatusBar`. Under pod/plugin skew a Keyboard-bridge call throws,
// so the returned promise rejected — and because bootstrap awaits it, every
// later lifecycle step (deep links, hardware back, pause/resume, network) was
// stranded. The guard must swallow + log the failure and resolve.
vi.mock("@capacitor/keyboard", () => ({
  KeyboardResize: { None: "none" },
  Keyboard: {
    setResizeMode: () => {
      throw new Error("Keyboard plugin unavailable (simulated pod skew)");
    },
    setScroll: async () => {},
    setAccessoryBarVisible: async () => {},
    addListener: () => {},
  },
}));

function makeIOSLifecycle() {
  return createMobileLifecycle({
    isNative: true,
    isIOS: true,
    isAndroid: false,
    logPrefix: "[test]",
    handleDeepLink: () => {},
  });
}

describe("initializeKeyboard bridge-failure guard (#12030 item 4)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("resolves instead of rejecting when an iOS Keyboard call throws", async () => {
    const lifecycle = makeIOSLifecycle();
    // Before the guard this promise rejected with the bridge error, which the
    // awaited bootstrap chain then propagated, stranding later wiring.
    await expect(lifecycle.initializeKeyboard()).resolves.toBeUndefined();
  });

  it("logs the plugin as unavailable (same degradation as initializeStatusBar)", async () => {
    const lifecycle = makeIOSLifecycle();
    await lifecycle.initializeKeyboard();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Keyboard plugin not available"),
      expect.anything(),
    );
  });

  it("leaves the rest of the lifecycle API callable after a keyboard failure", async () => {
    const lifecycle = makeIOSLifecycle();
    await lifecycle.initializeKeyboard();
    // The point of the fix: a keyboard failure no longer aborts bootstrap, so
    // sibling wiring the caller invokes next still runs.
    expect(() => lifecycle.initializeAppLifecycle()).not.toThrow();
  });
});
