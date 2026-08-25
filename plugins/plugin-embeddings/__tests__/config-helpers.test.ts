/**
 * Coverage for pure config helpers getSetting, getNumericSetting, getBooleanSetting, isBrowser.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";

import {
  getBooleanSetting,
  getNumericSetting,
  getSetting,
  isBrowser,
} from "../src/utils/config";

type Setting = string | number | boolean | null;
function makeRuntime(settings: Record<string, Setting> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => (key in settings ? settings[key] : null),
  } as unknown as IAgentRuntime;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getSetting", () => {
  it("returns undefined when unset and no default", () => {
    expect(getSetting(makeRuntime(), "MISSING_KEY")).toBeUndefined();
  });

  it("returns runtime value as-is via resolveSetting precedence", () => {
    expect(getSetting(makeRuntime({ MY_KEY: "  hello  " }), "MY_KEY")).toBe("  hello  ");
  });

  it("returns defaultValue when unset", () => {
    expect(getSetting(makeRuntime(), "MISSING", "fallback")).toBe("fallback");
  });

  it("returns empty string values as-is (resolveSetting handles trimming for env fallback)", () => {
    expect(getSetting(makeRuntime({ MY_KEY: "" }), "MY_KEY", "def")).toBe("");
    expect(getSetting(makeRuntime({ MY_KEY: "   " }), "MY_KEY", "def")).toBe("   ");
  });
});

describe("getNumericSetting", () => {
  it("returns default for unset or blank", () => {
    expect(getNumericSetting(makeRuntime(), "NUM_KEY", 42)).toBe(42);
    expect(getNumericSetting(makeRuntime({ NUM_KEY: "" }), "NUM_KEY", 42)).toBe(42);
    expect(getNumericSetting(makeRuntime({ NUM_KEY: "   " }), "NUM_KEY", 42)).toBe(42);
  });

  it("parses valid positive integers", () => {
    expect(getNumericSetting(makeRuntime({ NUM_KEY: "1" }), "NUM_KEY", 42)).toBe(1);
    expect(getNumericSetting(makeRuntime({ NUM_KEY: "  999  " }), "NUM_KEY", 42)).toBe(999);
  });

  it("rejects zero, negative, float, scientific, and mixed strings", () => {
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "0" }), "NUM_KEY", 42)).toThrow();
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "-5" }), "NUM_KEY", 42)).toThrow();
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "3.14" }), "NUM_KEY", 42)).toThrow();
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "1e3" }), "NUM_KEY", 42)).toThrow();
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "12px" }), "NUM_KEY", 42)).toThrow();
    expect(() => getNumericSetting(makeRuntime({ NUM_KEY: "123abc" }), "NUM_KEY", 42)).toThrow();
  });
});

describe("getBooleanSetting", () => {
  it("returns default when unset", () => {
    expect(getBooleanSetting(makeRuntime(), "FLAG", true)).toBe(true);
    expect(getBooleanSetting(makeRuntime(), "FLAG", false)).toBe(false);
  });

  it("recognizes true variants case-insensitively", () => {
    expect(getBooleanSetting(makeRuntime({ FLAG: "true" }), "FLAG", false)).toBe(true);
    expect(getBooleanSetting(makeRuntime({ FLAG: "TRUE" }), "FLAG", false)).toBe(true);
    expect(getBooleanSetting(makeRuntime({ FLAG: "1" }), "FLAG", false)).toBe(true);
    expect(getBooleanSetting(makeRuntime({ FLAG: "yes" }), "FLAG", false)).toBe(true);
    expect(getBooleanSetting(makeRuntime({ FLAG: "YES" }), "FLAG", false)).toBe(true);
  });

  it("returns false for other values", () => {
    expect(getBooleanSetting(makeRuntime({ FLAG: "false" }), "FLAG", true)).toBe(false);
    expect(getBooleanSetting(makeRuntime({ FLAG: "0" }), "FLAG", true)).toBe(false);
    expect(getBooleanSetting(makeRuntime({ FLAG: "no" }), "FLAG", true)).toBe(false);
    expect(getBooleanSetting(makeRuntime({ FLAG: "random" }), "FLAG", true)).toBe(false);
  });
});

describe("isBrowser", () => {
  it("returns false in Node environment", () => {
    expect(isBrowser()).toBe(false);
  });
});
