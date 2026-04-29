import { describe, expect, it } from "vitest";
import {
  assertSecretId,
  InvalidSecretIdError,
  isSecretId,
  matchesPattern,
  selectMostSpecific,
} from "../src/identifiers.js";

describe("identifiers", () => {
  describe("assertSecretId", () => {
    it("accepts well-formed ids", () => {
      expect(() => assertSecretId("llm.openrouter.apiKey")).not.toThrow();
      expect(() => assertSecretId("subscription.openai.accessToken")).not.toThrow();
      expect(() => assertSecretId("connector.telegram.botToken")).not.toThrow();
      expect(() =>
        assertSecretId("llm.openai.embeddingApiKey"),
      ).not.toThrow();
    });

    it("rejects ids with too few segments", () => {
      expect(() => assertSecretId("llm.openrouter")).toThrow(
        InvalidSecretIdError,
      );
      expect(() => assertSecretId("llm")).toThrow(InvalidSecretIdError);
    });

    it("rejects ids with uppercase domain or subject", () => {
      expect(() => assertSecretId("LLM.openrouter.apiKey")).toThrow();
      expect(() => assertSecretId("llm.OpenRouter.apiKey")).toThrow();
    });

    it("rejects ids starting with digits", () => {
      expect(() => assertSecretId("1.foo.bar")).toThrow();
    });

    it("rejects empty / whitespace", () => {
      expect(() => assertSecretId("")).toThrow();
      expect(() => assertSecretId(" llm.openrouter.apiKey")).toThrow();
    });
  });

  describe("isSecretId", () => {
    it("returns false for non-strings", () => {
      expect(isSecretId(42)).toBe(false);
      expect(isSecretId(null)).toBe(false);
    });
  });

  describe("matchesPattern", () => {
    it("matches exact ids", () => {
      expect(matchesPattern("llm.openrouter.apiKey", "llm.openrouter.apiKey")).toBe(true);
      expect(matchesPattern("llm.openrouter.apiKey", "llm.openai.apiKey")).toBe(false);
    });

    it("suffix wildcard matches any depth at or beyond prefix", () => {
      expect(matchesPattern("llm.openrouter.*", "llm.openrouter.apiKey")).toBe(true);
      expect(matchesPattern("llm.openrouter.*", "llm.openrouter.large.model")).toBe(true);
      expect(matchesPattern("llm.openrouter.*", "llm.openai.apiKey")).toBe(false);
      expect(matchesPattern("llm.*", "llm.openrouter.apiKey")).toBe(true);
    });

    it("single-segment wildcard matches one segment in that slot", () => {
      expect(matchesPattern("llm.*.apiKey", "llm.openrouter.apiKey")).toBe(true);
      expect(matchesPattern("llm.*.apiKey", "llm.openai.apiKey")).toBe(true);
      expect(matchesPattern("llm.*.apiKey", "llm.openai.embeddingApiKey")).toBe(false);
      // segment-count must match for non-trailing wildcards
      expect(matchesPattern("llm.*.apiKey", "llm.foo.bar.apiKey")).toBe(false);
    });

    it("universal pattern matches everything", () => {
      expect(matchesPattern("*", "llm.openrouter.apiKey")).toBe(true);
      expect(matchesPattern("*", "anything.at.all")).toBe(true);
    });
  });

  describe("selectMostSpecific", () => {
    it("prefers literal matches over wildcards", () => {
      const winner = selectMostSpecific(
        ["llm.openrouter.apiKey", "llm.openrouter.*", "*"],
        "llm.openrouter.apiKey",
      );
      expect(winner).toBe("llm.openrouter.apiKey");
    });

    it("prefers more-specific suffix patterns", () => {
      const winner = selectMostSpecific(
        ["llm.*", "llm.openrouter.*", "*"],
        "llm.openrouter.apiKey",
      );
      expect(winner).toBe("llm.openrouter.*");
    });

    it("returns null when nothing matches", () => {
      expect(
        selectMostSpecific(["llm.openai.*"], "subscription.openai.accessToken"),
      ).toBeNull();
    });

    it("treats `*` as the weakest match", () => {
      const winner = selectMostSpecific(
        ["*", "llm.*"],
        "llm.openrouter.apiKey",
      );
      expect(winner).toBe("llm.*");
    });
  });
});
