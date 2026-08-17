/**
 * Unit tests for getEnv in packages/logger/src/env.ts.
 * Exercises environment variable reading, whitespace trimming, empty string fallback
 * to defaultValue, and invalid key handling.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "./env.js";

describe("getEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TEST_LOGGER_VAR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads and trims an existing environment variable", () => {
    process.env.TEST_LOGGER_VAR = "  debug  ";
    expect(getEnv("TEST_LOGGER_VAR")).toBe("debug");
  });

  it("returns undefined when variable is unset and no default is given", () => {
    expect(getEnv("TEST_LOGGER_VAR")).toBeUndefined();
  });

  it("returns defaultValue when variable is unset", () => {
    expect(getEnv("TEST_LOGGER_VAR", "info")).toBe("info");
  });

  it("returns defaultValue when variable is set to empty string", () => {
    process.env.TEST_LOGGER_VAR = "";
    expect(getEnv("TEST_LOGGER_VAR", "info")).toBe("info");
  });

  it("returns defaultValue when variable is set to whitespace only", () => {
    process.env.TEST_LOGGER_VAR = "   \t\n  ";
    expect(getEnv("TEST_LOGGER_VAR", "info")).toBe("info");
  });

  it("returns defaultValue for invalid or missing keys", () => {
    expect(getEnv("", "fallback")).toBe("fallback");
    expect(getEnv(null as unknown as string, "fallback")).toBe("fallback");
    expect(getEnv(undefined as unknown as string, "fallback")).toBe("fallback");
  });
});
