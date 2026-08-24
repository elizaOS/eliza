/** Verifies isNativeServerPlatform native-shell detection against real globalThis state in vitest. */
import { afterEach, describe, expect, it } from "vitest";

import { isNativeServerPlatform } from "./is-native-server.js";

const globals = globalThis as Record<string, unknown>;
const originalCapacitor = globals.Capacitor;

describe("isNativeServerPlatform", () => {
  afterEach(() => {
    if (originalCapacitor === undefined) delete globals.Capacitor;
    else globals.Capacitor = originalCapacitor;
  });

  it("returns false when no Capacitor global exists (plain Node/Bun server)", () => {
    delete globals.Capacitor;
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns true when the Capacitor shell reports a native platform", () => {
    globals.Capacitor = { isNativePlatform: () => true };
    expect(isNativeServerPlatform()).toBe(true);
  });

  it("returns false when the Capacitor shell reports a non-native platform", () => {
    globals.Capacitor = { isNativePlatform: () => false };
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns false when Capacitor exists without an isNativePlatform method", () => {
    globals.Capacitor = {};
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("returns false when the Capacitor global is null", () => {
    globals.Capacitor = null;
    expect(isNativeServerPlatform()).toBe(false);
  });

  it("requires strictly true from isNativePlatform, not merely truthy values", () => {
    for (const truthy of ["true", 1, {}, Symbol.for("capacitor.native")]) {
      globals.Capacitor = { isNativePlatform: () => truthy };
      expect(isNativeServerPlatform()).toBe(false);
    }
  });
});
