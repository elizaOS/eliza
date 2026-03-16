import { describe, expect, it, vi } from "vitest";

// Mock @elizaos/core
vi.mock("@elizaos/core", () => ({
  logger: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock @google/genai
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(),
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
  HarmBlockThreshold: {
    BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE",
  },
}));

describe("Utility Functions", () => {
  describe("countTokens", () => {
    it("should estimate tokens from text length", async () => {
      const { countTokens } = await import("../../utils/tokenization");

      const result = await countTokens("Hello, world!");
      expect(result).toBeGreaterThan(0);
    });

    it("should return higher count for longer text", async () => {
      const { countTokens } = await import("../../utils/tokenization");

      const short = await countTokens("Hi");
      const long = await countTokens(
        "This is a much longer piece of text that should have more tokens"
      );

      expect(long).toBeGreaterThan(short);
    });
  });

  describe("getSafetySettings", () => {
    it("should return array of safety settings", async () => {
      const { getSafetySettings } = await import("../../utils/config");

      const settings = getSafetySettings();
      expect(Array.isArray(settings)).toBe(true);
      expect(settings.length).toBe(4);
    });

    it("should have category and threshold for each setting", async () => {
      const { getSafetySettings } = await import("../../utils/config");

      const settings = getSafetySettings();
      for (const setting of settings) {
        expect(setting).toHaveProperty("category");
        expect(setting).toHaveProperty("threshold");
      }
    });
  });
});
