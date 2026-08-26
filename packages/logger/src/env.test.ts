/**
 * Unit tests for minimal environment variable resolution in packages/logger/src/env.ts.
 * Exercises Node process.env resolution, defaultValue fallbacks, explicit empty string retention,
 * and browser window.ENV / __ENV__ global bag reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEnv, getEnvBoolean, getEnvNumber } from "./env.js";

describe("logger env reader", () => {
  const originalEnv = { ...process.env };
  const originalNodeVersion = process.versions.node;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(process.versions, "node", {
      configurable: true,
      value: originalNodeVersion,
    });
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

  it("reads and coerces browser environment bags when Node is unavailable", async () => {
    Object.defineProperty(process.versions, "node", {
      configurable: true,
      value: undefined,
    });
    vi.stubGlobal("window", {
      ENV: { LOG_LEVEL: "warn", RETRY_COUNT: 3 },
    });
    vi.stubGlobal("__ENV__", {
      FEATURE_ENABLED: true,
      LOG_LEVEL: "error",
    });
    vi.resetModules();

    const { getEnv: getBrowserEnv } = await import("./env.js");
    expect(getBrowserEnv("LOG_LEVEL")).toBe("error");
    expect(getBrowserEnv("RETRY_COUNT")).toBe("3");
    expect(getBrowserEnv("FEATURE_ENABLED")).toBe("true");
    expect(getBrowserEnv("MISSING", "fallback")).toBe("fallback");
  });

  it("parses booleans correctly with getEnvBoolean", () => {
    process.env.FLAG_TRUE = "true";
    process.env.FLAG_ONE = "1";
    process.env.FLAG_YES = "yes";
    process.env.FLAG_FALSE = "false";
    process.env.FLAG_ZERO = "0";

    expect(getEnvBoolean("FLAG_TRUE")).toBe(true);
    expect(getEnvBoolean("FLAG_ONE")).toBe(true);
    expect(getEnvBoolean("FLAG_YES")).toBe(true);
    expect(getEnvBoolean("FLAG_FALSE")).toBe(false);
    expect(getEnvBoolean("FLAG_ZERO")).toBe(false);
    expect(getEnvBoolean("UNSET_FLAG", true)).toBe(true);
    expect(getEnvBoolean("UNSET_FLAG", false)).toBe(false);
  });

  it("parses numbers correctly with getEnvNumber", () => {
    process.env.PORT = "3000";
    process.env.INVALID_NUM = "not-a-number";

    expect(getEnvNumber("PORT")).toBe(3000);
    expect(getEnvNumber("INVALID_NUM", 8080)).toBe(8080);
    expect(getEnvNumber("UNSET_NUM", 5000)).toBe(5000);
    expect(getEnvNumber("UNSET_NUM")).toBeUndefined();
  });
});
