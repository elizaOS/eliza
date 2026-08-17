/**
 * Verifies getNumericSetting accepts only positive safe integers instead of
 * prefix-parsing or returning invalid quantities. getResearchTimeout wraps it
 * with no further validation, and its only call site (research.ts) hands the
 * result straight to `AbortSignal.timeout`, where zero immediately times out
 * and negative values throw a low-level engine error. Every other current caller
 * (getEmbeddingDimensions, getImageDescriptionMaxTokens) also requires a
 * strictly positive value, so the validation belongs in the shared helper.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNumericSetting, getResearchTimeout } from "../utils/config";

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

afterEach(() => vi.unstubAllEnvs());

describe("getNumericSetting", () => {
  it("returns the default when the setting is unset", () => {
    expect(getNumericSetting(createRuntime(), "SOME_SETTING", 42)).toBe(42);
  });

  it("returns a configured positive integer", () => {
    expect(getNumericSetting(createRuntime({ SOME_SETTING: "100" }), "SOME_SETTING", 42)).toBe(100);
  });

  it("rejects zero", () => {
    expect(() =>
      getNumericSetting(createRuntime({ SOME_SETTING: "0" }), "SOME_SETTING", 42)
    ).toThrow(/must be a positive integer/);
  });

  it("rejects a negative value", () => {
    expect(() =>
      getNumericSetting(createRuntime({ SOME_SETTING: "-5" }), "SOME_SETTING", 42)
    ).toThrow(/must be a positive integer/);
  });

  it("rejects a non-numeric value", () => {
    expect(() =>
      getNumericSetting(createRuntime({ SOME_SETTING: "not-a-number" }), "SOME_SETTING", 42)
    ).toThrow(/must be a positive integer/);
  });

  it.each(["1.5", "123junk", String(Number.MAX_SAFE_INTEGER + 1)])(
    "rejects non-integer or unsafe value %s",
    (value) => {
      expect(() =>
        getNumericSetting(createRuntime({ SOME_SETTING: value }), "SOME_SETTING", 42)
      ).toThrow(/must be a positive integer/);
    }
  );
});

describe("getResearchTimeout", () => {
  it("rejects OPENAI_RESEARCH_TIMEOUT=0 with a clean validation error", () => {
    expect(() => getResearchTimeout(createRuntime({ OPENAI_RESEARCH_TIMEOUT: "0" }))).toThrow(
      /must be a positive integer/
    );
  });

  it("rejects a negative OPENAI_RESEARCH_TIMEOUT", () => {
    expect(() => getResearchTimeout(createRuntime({ OPENAI_RESEARCH_TIMEOUT: "-1000" }))).toThrow(
      /must be a positive integer/
    );
  });

  it("accepts a positive OPENAI_RESEARCH_TIMEOUT", () => {
    expect(getResearchTimeout(createRuntime({ OPENAI_RESEARCH_TIMEOUT: "5000" }))).toBe(5000);
  });

  it("falls back to the 1-hour default when unset", () => {
    expect(getResearchTimeout(createRuntime())).toBe(3600000);
  });
});
