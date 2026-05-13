import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBackendStartupTimeoutMs } from "./electrobun-runtime";

// `getBackendStartupTimeoutMs` returns 30s for web/cloud and 180s for any
// build that hosts the on-device agent (Electrobun desktop, ElizaOS UA,
// or any Capacitor native platform). The Capacitor probe is lazy: it
// reads `globalThis.Capacitor` and falls back to 30s when missing.

describe("getBackendStartupTimeoutMs — Capacitor native widening", () => {
  let originalCapacitor: unknown;
  let originalNavigator: Navigator | undefined;

  beforeEach(() => {
    originalCapacitor = (globalThis as { Capacitor?: unknown }).Capacitor;
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    (globalThis as { Capacitor?: unknown }).Capacitor = originalCapacitor;
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  function setNavigatorUA(ua: string): void {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: ua },
      configurable: true,
    });
  }

  it("returns 30_000ms for plain web (no Capacitor, no ElizaOS UA)", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
    setNavigatorUA("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0");
    expect(getBackendStartupTimeoutMs()).toBe(30_000);
  });

  it("returns 180_000ms when Capacitor.isNativePlatform() is true (Android sideload, iOS test build)", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    setNavigatorUA("Mozilla/5.0 (Linux; Android 16; Seeker)");
    expect(getBackendStartupTimeoutMs()).toBe(180_000);
  });

  it("returns 180_000ms when Capacitor.getPlatform() is 'ios' even if isNativePlatform missing", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => "ios",
    };
    setNavigatorUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)");
    expect(getBackendStartupTimeoutMs()).toBe(180_000);
  });

  it("returns 180_000ms when ElizaOS UA marker is present (legacy path, AOSP build)", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
    setNavigatorUA(
      "Mozilla/5.0 (Linux; Android 14; Moto G Play 2024) ElizaOS/1.0",
    );
    expect(getBackendStartupTimeoutMs()).toBe(180_000);
  });

  it("returns 30_000ms when Capacitor.getPlatform() is 'web' (Capacitor PWA build, not native)", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => "web",
    };
    setNavigatorUA("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0");
    expect(getBackendStartupTimeoutMs()).toBe(30_000);
  });

  it("returns 30_000ms when probing Capacitor throws (defensive fall-through)", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => {
        throw new Error("plugin not initialized");
      },
    };
    setNavigatorUA("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0");
    expect(getBackendStartupTimeoutMs()).toBe(30_000);
  });
});
