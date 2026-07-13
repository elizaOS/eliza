// @vitest-environment jsdom

/**
 * Auto-start onboarding support (`first-run-autostart.ts`) driven through its
 * real seams: desktop detection via the injected Electrobun renderer bridge
 * (`window.__ELIZA_ELECTROBUN_RPC__` / `__electrobunWindowId`, exactly what the
 * shell preload sets), the desktop enable write through the real
 * `invokeDesktopBridgeRequest` helper, and the replay gate through the real
 * URL. Mocks sit only at the native module boundaries (@capacitor/core's
 * platform report, @capacitor/preferences' store).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capacitorPlatform: "web" as string,
  preferencesSet: vi.fn(async (_options: { key: string; value: string }) => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.capacitorPlatform,
    isNativePlatform: () => mocks.capacitorPlatform !== "web",
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    set: mocks.preferencesSet,
  },
}));

import type { ElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import {
  ANDROID_BACKGROUND_ENABLED_PREF_KEY,
  detectAutostartPlatform,
  enableAutostart,
} from "./first-run-autostart";

type BridgeWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
  __electrobunWindowId?: number;
};

const bridgeWindow = window as BridgeWindow;

function installDesktopBridge(
  desktopSetAutoLaunch: (params?: unknown) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(desktopSetAutoLaunch);
  bridgeWindow.__ELIZA_ELECTROBUN_RPC__ = {
    request: { desktopSetAutoLaunch: spy },
    onMessage: () => {},
    offMessage: () => {},
  };
  return spy;
}

afterEach(() => {
  delete bridgeWindow.__ELIZA_ELECTROBUN_RPC__;
  delete bridgeWindow.__electrobunWindowId;
  mocks.capacitorPlatform = "web";
  mocks.preferencesSet.mockClear();
  mocks.preferencesSet.mockResolvedValue(undefined);
  window.history.pushState({}, "", "/");
});

describe("detectAutostartPlatform", () => {
  it("returns null on plain web (no Electrobun bridge, Capacitor 'web')", () => {
    expect(detectAutostartPlatform()).toBeNull();
  });

  it("returns 'desktop' when the Electrobun renderer bridge is present", () => {
    bridgeWindow.__electrobunWindowId = 1;
    expect(detectAutostartPlatform()).toBe("desktop");
  });

  it("returns 'android' on the native Android Capacitor shell", () => {
    mocks.capacitorPlatform = "android";
    expect(detectAutostartPlatform()).toBe("android");
  });

  it("returns null on iOS — no app-controlled auto-start there", () => {
    mocks.capacitorPlatform = "ios";
    expect(detectAutostartPlatform()).toBeNull();
  });
});

describe("enableAutostart (desktop)", () => {
  it("invokes desktopSetAutoLaunch with enabled:true, openAsHidden:false", async () => {
    const spy = installDesktopBridge(async () => undefined);
    const result = await enableAutostart("desktop");
    expect(result).toEqual({ status: "enabled" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ enabled: true, openAsHidden: false });
  });

  it("fails (never rejects) when the bridge/method is absent", async () => {
    const result = await enableAutostart("desktop");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("desktop bridge");
    }
  });

  it("translates an RPC rejection into a typed failure with its message", async () => {
    installDesktopBridge(async () => {
      throw new Error("plist write failed");
    });
    const result = await enableAutostart("desktop");
    expect(result).toEqual({
      status: "failed",
      message: "plist write failed",
    });
  });
});

describe("enableAutostart (android)", () => {
  it("writes the boot receiver's Capacitor preference as the STRING 'true'", async () => {
    const result = await enableAutostart("android");
    expect(result).toEqual({ status: "enabled" });
    expect(mocks.preferencesSet).toHaveBeenCalledTimes(1);
    expect(mocks.preferencesSet).toHaveBeenCalledWith({
      key: ANDROID_BACKGROUND_ENABLED_PREF_KEY,
      value: "true",
    });
  });

  it("translates a Preferences failure into a typed failure", async () => {
    mocks.preferencesSet.mockRejectedValueOnce(
      new Error("preferences unavailable"),
    );
    const result = await enableAutostart("android");
    expect(result).toEqual({
      status: "failed",
      message: "preferences unavailable",
    });
  });
});

describe("enableAutostart (onboarding replay, #14382)", () => {
  it("skips the desktop write entirely under ?onboarding-replay=1", async () => {
    const spy = installDesktopBridge(async () => undefined);
    window.history.pushState({}, "", "/?onboarding-replay=1");
    const result = await enableAutostart("desktop");
    expect(result).toEqual({ status: "replay-skipped" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips the android write entirely under ?onboarding-replay=1", async () => {
    window.history.pushState({}, "", "/?onboarding-replay=1");
    const result = await enableAutostart("android");
    expect(result).toEqual({ status: "replay-skipped" });
    expect(mocks.preferencesSet).not.toHaveBeenCalled();
  });
});
