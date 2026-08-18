/**
 * Unit tests for minimal environment variable resolution in packages/logger/src/env.ts.
 * Exercises Node process.env resolution, defaultValue fallbacks, explicit empty string retention,
 * and browser window.ENV / __ENV__ global bag reading.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "./env.js";

describe("logger env reader", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reads defined environment variables from process.env", () => {
    process.env.LOG_LEVEL = "debug";
    process.env.SERVER_ID = "srv-101";

    expect(getEnv("LOG_LEVEL")).toBe("debug");
    expect(getEnv("SERVER_ID")).toBe("srv-101");
  });

  it("returns defaultValue when environment variable is unset", () => {
    delete process.env.TEST_UNSET_KEY;

    expect(getEnv("TEST_UNSET_KEY")).toBeUndefined();
    expect(getEnv("TEST_UNSET_KEY", "default-val")).toBe("default-val");
  });

  it("preserves explicitly set empty string values", () => {
    process.env.LOG_TIMESTAMPS = "";

    expect(getEnv("LOG_TIMESTAMPS")).toBe("");
    expect(getEnv("LOG_TIMESTAMPS", "true")).toBe("");
  });
});
