/**
 * Unit coverage for the iOS-only ElizaKeyboard Capacitor shim. Capacitor is
 * mocked at the host boundary; getKeyboardDictationBridge is the real module,
 * re-imported after each case so the module-level cache does not leak.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardDictationBridge } from "../keyboard-dictation-bridge.js";

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  registerPlugin: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.getPlatform(),
    registerPlugin: (name: string) => mocks.registerPlugin(name),
  },
}));

function makePlugin(): KeyboardDictationBridge {
  return {
    setDictationState: async () => ({ saved: true }),
    clearDictationState: async () => ({ cleared: true }),
    getDictationState: async () => ({ pending: false }),
  };
}

describe("getKeyboardDictationBridge", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it.each(["web", "android", "electron", "iOS", "IOS", "ios ", " ios", ""])(
    "returns null on platform %j without registering ElizaKeyboard",
    async (platform) => {
      const { getKeyboardDictationBridge } = await import(
        "../keyboard-dictation-bridge.js"
      );
      mocks.getPlatform.mockReturnValue(platform);

      expect(getKeyboardDictationBridge()).toBeNull();
      expect(mocks.registerPlugin).not.toHaveBeenCalled();
    },
  );

  it("registers ElizaKeyboard once on iOS and returns that plugin instance", async () => {
    const { getKeyboardDictationBridge } = await import(
      "../keyboard-dictation-bridge.js"
    );
    mocks.getPlatform.mockReturnValue("ios");
    const plugin = makePlugin();
    mocks.registerPlugin.mockReturnValue(plugin);

    const first = getKeyboardDictationBridge();
    const second = getKeyboardDictationBridge();

    expect(first).toBe(plugin);
    expect(second).toBe(plugin);
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("ElizaKeyboard");
  });

  it("returns null on a later non-iOS call even after an iOS registration", async () => {
    const { getKeyboardDictationBridge } = await import(
      "../keyboard-dictation-bridge.js"
    );
    const plugin = makePlugin();
    mocks.registerPlugin.mockReturnValue(plugin);

    mocks.getPlatform.mockReturnValue("ios");
    expect(getKeyboardDictationBridge()).toBe(plugin);

    mocks.getPlatform.mockReturnValue("web");
    expect(getKeyboardDictationBridge()).toBeNull();
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached plugin when iOS is selected again after a non-iOS probe", async () => {
    const { getKeyboardDictationBridge } = await import(
      "../keyboard-dictation-bridge.js"
    );
    const plugin = makePlugin();
    mocks.registerPlugin.mockReturnValue(plugin);

    mocks.getPlatform.mockReturnValue("ios");
    expect(getKeyboardDictationBridge()).toBe(plugin);

    mocks.getPlatform.mockReturnValue("android");
    expect(getKeyboardDictationBridge()).toBeNull();

    mocks.getPlatform.mockReturnValue("ios");
    expect(getKeyboardDictationBridge()).toBe(plugin);
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
  });

  it("registers on the first iOS call after earlier non-iOS probes", async () => {
    const { getKeyboardDictationBridge } = await import(
      "../keyboard-dictation-bridge.js"
    );
    const plugin = makePlugin();
    mocks.registerPlugin.mockReturnValue(plugin);

    mocks.getPlatform.mockReturnValue("android");
    expect(getKeyboardDictationBridge()).toBeNull();
    expect(mocks.registerPlugin).not.toHaveBeenCalled();

    mocks.getPlatform.mockReturnValue("ios");
    expect(getKeyboardDictationBridge()).toBe(plugin);
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("ElizaKeyboard");
  });
});
