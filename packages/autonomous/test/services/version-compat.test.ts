import { describe, test, expect } from "vitest";
import {
  parseSemver,
  compareSemver,
  versionSatisfies,
  diagnoseNoAIProvider,
  AI_PROVIDER_PLUGINS,
} from "../../src/services/version-compat";

describe("parseSemver", () => {
  test("parses a stable release", () => {
    expect(parseSemver("2.0.0")).toEqual([2, 0, 0, Infinity]);
  });

  test("parses an alpha pre-release", () => {
    expect(parseSemver("2.0.0-alpha.4")).toEqual([2, 0, 0, 4]);
  });

  test("parses a nightly pre-release", () => {
    expect(parseSemver("2.0.0-nightly.20260208")).toEqual([
      2, 0, 0, 20260208,
    ]);
  });

  test("returns null for unparseable version", () => {
    expect(parseSemver("not-a-version")).toBeNull();
  });

  test("returns null for partial version string", () => {
    expect(parseSemver("2.0")).toBeNull();
  });

  test("parses beta and rc tags", () => {
    expect(parseSemver("1.2.3-beta.7")).toEqual([1, 2, 3, 7]);
    expect(parseSemver("1.2.3-rc.1")).toEqual([1, 2, 3, 1]);
  });
});

describe("compareSemver", () => {
  test("equal versions return 0", () => {
    expect(compareSemver("2.0.0-alpha.4", "2.0.0-alpha.4")).toBe(0);
  });

  test("earlier alpha is less than later alpha", () => {
    expect(compareSemver("2.0.0-alpha.3", "2.0.0-alpha.4")).toBe(-1);
  });

  test("later alpha is greater than earlier alpha", () => {
    expect(compareSemver("2.0.0-alpha.5", "2.0.0-alpha.4")).toBe(1);
  });

  test("stable release is greater than any alpha", () => {
    expect(compareSemver("2.0.0", "2.0.0-alpha.99")).toBe(1);
  });

  test("returns null when either version is unparseable", () => {
    expect(compareSemver("garbage", "2.0.0")).toBeNull();
    expect(compareSemver("2.0.0", "garbage")).toBeNull();
  });

  test("compares major versions correctly", () => {
    expect(compareSemver("3.0.0", "2.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
  });
});

describe("versionSatisfies", () => {
  test("returns true when installed equals required", () => {
    expect(versionSatisfies("2.0.0-alpha.4", "2.0.0-alpha.4")).toBe(true);
  });

  test("returns true when installed exceeds required", () => {
    expect(versionSatisfies("2.0.0-alpha.5", "2.0.0-alpha.4")).toBe(true);
  });

  test("returns false when installed is below required", () => {
    expect(versionSatisfies("2.0.0-alpha.3", "2.0.0-alpha.4")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(versionSatisfies("garbage", "2.0.0")).toBe(false);
  });
});

describe("diagnoseNoAIProvider", () => {
  test("returns null when at least one AI provider loaded", () => {
    const result = diagnoseNoAIProvider(["@elizaos/plugin-openai"], []);
    expect(result).toBeNull();
  });

  test("returns config message when no providers were attempted", () => {
    const result = diagnoseNoAIProvider(["some-other-plugin"], []);
    expect(result).toContain("No AI provider plugin was loaded");
    expect(result).toContain("API key");
  });

  test("detects version skew signature in failed plugins", () => {
    const result = diagnoseNoAIProvider([], [
      {
        name: "@elizaos/plugin-openai",
        error: "does not provide an export named 'MAX_EMBEDDING_TOKENS'",
      },
    ]);
    expect(result).toContain("Version skew detected");
    expect(result).toContain("@elizaos/plugin-openai");
  });

  test("returns generic failure message for non-version-skew errors", () => {
    const result = diagnoseNoAIProvider([], [
      {
        name: "@elizaos/plugin-openai",
        error: "Connection refused",
      },
    ]);
    expect(result).toContain("All AI provider plugins failed to load");
    expect(result).toContain("Connection refused");
  });
});

describe("AI_PROVIDER_PLUGINS", () => {
  test("is a non-empty array of strings", () => {
    expect(AI_PROVIDER_PLUGINS.length).toBeGreaterThan(0);
    for (const name of AI_PROVIDER_PLUGINS) {
      expect(typeof name).toBe("string");
    }
  });
});
