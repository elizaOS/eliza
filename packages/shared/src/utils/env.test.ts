import { describe, expect, it } from "vitest";
import {
  isEnvDisabled,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
} from "./env";

/**
 * Env value normalization + the boolean-disabled check. Empty/whitespace must
 * normalize to absent, and isEnvDisabled must treat only explicit falsy tokens
 * as "off" (default-enabled) — a loose check here would flip feature defaults.
 */

describe("normalizeEnvValue / normalizeEnvValueOrNull", () => {
  it("trims, maps empty/non-string to absent", () => {
    expect(normalizeEnvValue("  hi ")).toBe("hi");
    expect(normalizeEnvValue("   ")).toBeUndefined();
    expect(normalizeEnvValue(42)).toBeUndefined();
    expect(normalizeEnvValueOrNull("  hi ")).toBe("hi");
    expect(normalizeEnvValueOrNull("")).toBeNull();
  });
});

describe("isEnvDisabled", () => {
  it("treats only explicit falsy tokens as disabled", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
      expect(isEnvDisabled(v)).toBe(true);
    }
    for (const v of ["1", "true", "on", "yes", "", undefined]) {
      expect(isEnvDisabled(v)).toBe(false);
    }
  });
});
