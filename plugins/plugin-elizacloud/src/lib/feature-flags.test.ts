/**
 * Tests for the elizacloud wallet feature-flag parsing.
 *
 * Materiality: `ENABLE_CLOUD_WALLET` gates whether the cloud wallet surfaces
 * in product flows. The parser must accept the canonical truthy/falsy
 * spellings (including case/whitespace variants) and must NOT guess on
 * unrecognized values — a typo like "1 " (trailing space is trimmed) is fine,
 * but a value like "yes please" or "2" must fall back instead of flipping the
 * feature on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloudWalletEnabled } from "./feature-flags";

const FLAG = "ENABLE_CLOUD_WALLET";
const ORIGINAL = process.env[FLAG];

describe("isCloudWalletEnabled", () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = ORIGINAL;
    }
  });

  it("defaults to disabled when the flag is unset or empty", () => {
    expect(isCloudWalletEnabled()).toBe(false);
    process.env[FLAG] = "";
    expect(isCloudWalletEnabled()).toBe(false);
  });

  it("accepts canonical truthy spellings case- and space-insensitively", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      process.env[FLAG] = value;
      expect(isCloudWalletEnabled()).toBe(true);
    }
    for (const value of [" TRUE ", "  Yes  ", "ON"]) {
      process.env[FLAG] = value;
      expect(isCloudWalletEnabled()).toBe(true);
    }
  });

  it("accepts canonical falsy spellings case-insensitively", () => {
    for (const value of ["0", "false", "no", "off", "False", "OFF"]) {
      process.env[FLAG] = value;
      expect(isCloudWalletEnabled()).toBe(false);
    }
  });

  it("falls back for unrecognized values instead of guessing", () => {
    for (const value of ["2", "enabled", "yes please", "1.0", "TRUE-ish"]) {
      process.env[FLAG] = value;
      expect(isCloudWalletEnabled()).toBe(false);
    }
  });
});
