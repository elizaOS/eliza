/**
 * Unit coverage for deferred-plugin watchdog configuration validation.
 */

import { describe, expect, it } from "vitest";
import { parseDeferredPluginRegistrationTimeoutMs } from "./deferred-plugin-timeout.ts";

describe("parseDeferredPluginRegistrationTimeoutMs", () => {
  it("uses the default only when the setting is absent or blank", () => {
    expect(parseDeferredPluginRegistrationTimeoutMs(undefined)).toBe(30_000);
    expect(parseDeferredPluginRegistrationTimeoutMs("   ")).toBe(30_000);
  });

  it("accepts positive decimal integers through the maximum timer delay", () => {
    expect(parseDeferredPluginRegistrationTimeoutMs(" 45000 ")).toBe(45_000);
    expect(parseDeferredPluginRegistrationTimeoutMs("00045")).toBe(45);
    expect(parseDeferredPluginRegistrationTimeoutMs("2147483647")).toBe(
      2_147_483_647,
    );
  });

  it.each(["0", "-1", "45.5", "1e3", "45ms", "NaN", "Infinity"])(
    "rejects malformed or non-positive explicit value %s",
    (value) => {
      expect(() => parseDeferredPluginRegistrationTimeoutMs(value)).toThrow(
        /must be a positive decimal integer/,
      );
    },
  );

  it.each(["2147483648", "9007199254740992"])(
    "rejects explicit value %s that Node cannot schedule as requested",
    (value) => {
      expect(() => parseDeferredPluginRegistrationTimeoutMs(value)).toThrow(
        /no greater than 2147483647/,
      );
    },
  );
});
