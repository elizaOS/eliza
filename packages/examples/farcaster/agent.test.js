/**
 * Deterministic coverage for Farcaster example environment validation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { requireEnv, validateEnvironment } from "./agent";

const keys = [
  "OPENAI_API_KEY",
  "FARCASTER_FID",
  "FARCASTER_SIGNER_UUID",
  "FARCASTER_NEYNAR_API_KEY",
];

const originalEnv = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function clearEnv() {
  for (const key of keys) {
    delete process.env[key];
  }
}

describe("Farcaster example environment validation", () => {
  test("requireEnv trims present values and rejects missing values", () => {
    clearEnv();

    expect(() => requireEnv("OPENAI_API_KEY")).toThrow(
      "Missing required environment variable: OPENAI_API_KEY",
    );

    process.env.OPENAI_API_KEY = "  openai-key  ";
    expect(requireEnv("OPENAI_API_KEY")).toBe("  openai-key  ");
  });

  test("validateEnvironment requires model and Neynar signer credentials", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.FARCASTER_FID = "123";
    process.env.FARCASTER_SIGNER_UUID = "signer";

    expect(() => validateEnvironment()).toThrow(
      "Missing required environment variable: FARCASTER_NEYNAR_API_KEY",
    );

    process.env.FARCASTER_NEYNAR_API_KEY = "neynar";
    expect(() => validateEnvironment()).not.toThrow();
  });
});
