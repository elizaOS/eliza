/**
 * Unit tests for minimal environment variable resolution in packages/logger/src/env.ts.
 * Exercises Node process.env resolution, getEnvBoolean / getEnvNumber coercion,
 * defaultValue fallbacks, explicit empty string retention, and browser window.ENV /
 * __ENV__ global bag reading.
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
    process.env.FLAG_ON = "on";
    process.env.FLAG_ON_PADDED = "  ON  ";
    process.env.FLAG_FALSE = "false";
    process.env.FLAG_ZERO = "0";
    process.env.FLAG_NO = "no";
    process.env.FLAG_OFF = "off";
    process.env.FLAG_OFF_PADDED = "  Off  ";
    process.env.FLAG_UNKNOWN = "maybe";
    process.env.FLAG_EMPTY = "";

    expect(getEnvBoolean("FLAG_TRUE")).toBe(true);
    expect(getEnvBoolean("FLAG_ONE")).toBe(true);
    expect(getEnvBoolean("FLAG_YES")).toBe(true);
    expect(getEnvBoolean("FLAG_ON")).toBe(true);
    expect(getEnvBoolean("FLAG_ON_PADDED")).toBe(true);
    expect(getEnvBoolean("FLAG_FALSE")).toBe(false);
    expect(getEnvBoolean("FLAG_ZERO")).toBe(false);
    expect(getEnvBoolean("FLAG_NO")).toBe(false);
    expect(getEnvBoolean("FLAG_OFF")).toBe(false);
    expect(getEnvBoolean("FLAG_OFF_PADDED")).toBe(false);
    expect(getEnvBoolean("FLAG_UNKNOWN", true)).toBe(true);
    expect(getEnvBoolean("FLAG_UNKNOWN", false)).toBe(false);
    expect(getEnvBoolean("FLAG_EMPTY", true)).toBe(true);
    expect(getEnvBoolean("UNSET_FLAG", true)).toBe(true);
    expect(getEnvBoolean("UNSET_FLAG", false)).toBe(false);
  });

  it("parses numbers correctly with getEnvNumber and guards empty strings", () => {
    process.env.TEST_PORT = "3000";
    process.env.TEST_FLOAT = "3.14";
    process.env.TEST_PADDED = "  42  ";
    process.env.TEST_EMPTY = "";
    process.env.TEST_WHITESPACE = "   ";
    process.env.INVALID_NUM = "not-a-number";
    process.env.INFINITY_NUM = "Infinity";

    expect(getEnvNumber("TEST_PORT")).toBe(3000);
    expect(getEnvNumber("TEST_FLOAT")).toBe(3.14);
    expect(getEnvNumber("TEST_PADDED")).toBe(42);
    expect(getEnvNumber("TEST_EMPTY", 8080)).toBe(8080);
    expect(getEnvNumber("TEST_WHITESPACE", 8080)).toBe(8080);
    expect(getEnvNumber("INVALID_NUM", 8080)).toBe(8080);
    expect(getEnvNumber("INFINITY_NUM", 8080)).toBe(8080);
    expect(getEnvNumber("UNSET_NUM", 5000)).toBe(5000);
    expect(getEnvNumber("UNSET_NUM")).toBeUndefined();
  });
});
