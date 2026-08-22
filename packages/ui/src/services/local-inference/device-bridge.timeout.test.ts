/**
 * Covers `ELIZA_DEVICE_GENERATE_TIMEOUT_MS` parsing. The value bounds every
 * device generate/embed call, so a silently truncated setting aborts real work.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveDeviceCallTimeoutMs } from "./device-bridge";

const KEY = "ELIZA_DEVICE_GENERATE_TIMEOUT_MS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("resolveDeviceCallTimeoutMs", () => {
  it("ignores a trailing-garbage timeout instead of parsing its prefix", () => {
    // parseInt("5junk") is 5 — a 5ms budget that aborts every device call.
    process.env[KEY] = "5junk";
    expect(resolveDeviceCallTimeoutMs()).toBe(60_000);
  });

  it("still honours a clean timeout", () => {
    process.env[KEY] = "30000";
    expect(resolveDeviceCallTimeoutMs()).toBe(30_000);
  });

  it("keeps a signed value and rejects one past the safe range", () => {
    // `parseInt` accepted "+30000"; rejecting it would be a regression.
    process.env[KEY] = "+30000";
    expect(resolveDeviceCallTimeoutMs()).toBe(30_000);
    process.env[KEY] = "9007199254740993";
    expect(resolveDeviceCallTimeoutMs()).toBe(60_000);
  });

  it("falls back when unset", () => {
    delete process.env[KEY];
    expect(resolveDeviceCallTimeoutMs()).toBe(60_000);
  });
});
