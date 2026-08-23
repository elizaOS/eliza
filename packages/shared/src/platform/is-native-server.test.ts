/**
 * Unit tests for server-side native platform detection.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isNativeServerPlatform } from "./is-native-server.js";

describe("isNativeServerPlatform", () => {
  const originalCapacitor = (globalThis as Record<string, unknown>).Capacitor;

  afterEach(() => {
    if (originalCapacitor === undefined) {
      delete (globalThis as Record<string, unknown>).Capacitor;
    } else {
      (globalThis as Record<string, unknown>).Capacitor = originalCapacitor;
    }
  });

  it("returns false in standard Node/Bun environments without Capacitor global", () => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns false when Capacitor global exists without isNativePlatform", () => {
    (globalThis as Record<string, unknown>).Capacitor = {};
    expect(isNativeServerPlatform()).toBe(false);

    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: undefined,
    };
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns false when Capacitor.isNativePlatform() returns false", () => {
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => false,
    };
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns true when running inside native mobile shell with Capacitor.isNativePlatform() true", () => {
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
    expect(isNativeServerPlatform()).toBe(true);
  });
});
