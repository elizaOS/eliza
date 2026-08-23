import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  registerPlugin: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.getPlatform(),
    registerPlugin: (...a: unknown[]) => mocks.registerPlugin(...a),
  },
}));

import { getKeyboardDictationBridge } from "../keyboard-dictation-bridge.ts";

describe("getKeyboardDictationBridge", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it("returns null off iOS", async () => {
    const { getKeyboardDictationBridge: g } = await import(
      "../keyboard-dictation-bridge.ts"
    );
    mocks.getPlatform.mockReturnValue("android");
    expect(g()).toBeNull();
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });

  it("registers and caches the plugin on iOS", async () => {
    const { getKeyboardDictationBridge: g } = await import(
      "../keyboard-dictation-bridge.ts"
    );
    mocks.getPlatform.mockReturnValue("ios");
    const bridge = { setDictationState: async () => ({ saved: true }) };
    mocks.registerPlugin.mockReturnValue(bridge);
    expect(g()).toBe(bridge);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("ElizaKeyboard");
    // 缓存：第二次不重复注册
    expect(g()).toBe(bridge);
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
  });
});
