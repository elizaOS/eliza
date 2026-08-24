/**
 * Unit coverage for the env-var normalization helpers every config builder in
 * the UI relies on: blank means absent, non-string config values are rejected,
 * and the boolean-ish disable tokens are matched exactly after trim+lowercase
 * so `"offline"` never disables a feature that `"off"` would. Deterministic;
 * no DOM, network, or clock.
 */
import { describe, expect, it } from "vitest";
import {
  isEnvDisabled,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
} from "./env";

describe("normalizeEnvValue", () => {
  it("returns undefined for non-string values", () => {
    expect(normalizeEnvValue(undefined)).toBeUndefined();
    expect(normalizeEnvValue(null)).toBeUndefined();
    expect(normalizeEnvValue(0)).toBeUndefined();
    expect(normalizeEnvValue(42)).toBeUndefined();
    expect(normalizeEnvValue(Number.NaN)).toBeUndefined();
    expect(normalizeEnvValue(false)).toBeUndefined();
    expect(normalizeEnvValue(true)).toBeUndefined();
    expect(normalizeEnvValue({ value: "x" })).toBeUndefined();
    expect(normalizeEnvValue(["x"])).toBeUndefined();
  });

  it("treats empty and whitespace-only strings as absent", () => {
    expect(normalizeEnvValue("")).toBeUndefined();
    expect(normalizeEnvValue("   ")).toBeUndefined();
    expect(normalizeEnvValue("\t\n\r ")).toBeUndefined();
  });

  it("trims surrounding whitespace but preserves interior content", () => {
    expect(normalizeEnvValue("production")).toBe("production");
    expect(normalizeEnvValue("  staging  ")).toBe("staging");
    expect(normalizeEnvValue("\thttp://localhost:3000\n")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeEnvValue("a b")).toBe("a b");
  });
});

describe("normalizeEnvValueOrNull", () => {
  it("maps absent values to null instead of undefined", () => {
    expect(normalizeEnvValueOrNull(undefined)).toBeNull();
    expect(normalizeEnvValueOrNull(null)).toBeNull();
    expect(normalizeEnvValueOrNull(7)).toBeNull();
    expect(normalizeEnvValueOrNull("")).toBeNull();
    expect(normalizeEnvValueOrNull(" \t ")).toBeNull();
  });

  it("passes trimmed strings through unchanged", () => {
    expect(normalizeEnvValueOrNull("key")).toBe("key");
    expect(normalizeEnvValueOrNull("  key ")).toBe("key");
  });
});

describe("isEnvDisabled", () => {
  it("keeps features enabled when the variable is missing or empty", () => {
    expect(isEnvDisabled(undefined)).toBe(false);
    expect(isEnvDisabled("")).toBe(false);
    expect(isEnvDisabled("   ")).toBe(false);
  });

  it("recognizes the exact disable tokens", () => {
    expect(isEnvDisabled("0")).toBe(true);
    expect(isEnvDisabled("false")).toBe(true);
    expect(isEnvDisabled("off")).toBe(true);
    expect(isEnvDisabled("no")).toBe(true);
  });

  it("matches disable tokens case-insensitively after trimming", () => {
    expect(isEnvDisabled("FALSE")).toBe(true);
    expect(isEnvDisabled(" Off ")).toBe(true);
    expect(isEnvDisabled("\nNO\t")).toBe(true);
    expect(isEnvDisabled(" False ")).toBe(true);
  });

  it("keeps features enabled for any other value, including near-miss prefixes", () => {
    expect(isEnvDisabled("1")).toBe(false);
    expect(isEnvDisabled("true")).toBe(false);
    expect(isEnvDisabled("yes")).toBe(false);
    expect(isEnvDisabled("enabled")).toBe(false);
    // Prefixes of the disable tokens must NOT match: only the whole token
    // disables, so an unrelated value like "offline" stays enabled.
    expect(isEnvDisabled("offline")).toBe(false);
    expect(isEnvDisabled("notice")).toBe(false);
    expect(isEnvDisabled("00")).toBe(false);
  });
});
