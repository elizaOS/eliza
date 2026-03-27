import { describe, expect, it } from "vitest";
import { validateMoltbookSettings } from "../src/environment";
import type { MoltbookSettings } from "../src/types";

describe("validateMoltbookSettings", () => {
  const validSettings: MoltbookSettings = {
    agentName: "TestAgent",
    moltbookToken: "test-token",
    llmApiKey: "test-api-key",
    llmBaseUrl: "https://api.example.com",
    model: "test-model",
    autonomyIntervalMs: 30000,
    autonomyMaxSteps: 10,
    autonomousMode: true,
  };

  describe("valid configurations", () => {
    it("accepts valid settings with all fields", () => {
      const result = validateMoltbookSettings(validSettings);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts settings without moltbook token (with warning)", () => {
      const settings = { ...validSettings, moltbookToken: undefined };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "MOLTBOOK_TOKEN not set - posting and commenting will be disabled"
      );
    });

    it("accepts non-autonomous mode without LLM key", () => {
      const settings = {
        ...validSettings,
        autonomousMode: false,
        llmApiKey: undefined,
      };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid configurations", () => {
    it("rejects autonomous mode without LLM API key", () => {
      const settings = { ...validSettings, llmApiKey: undefined };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("LLM_API_KEY is required for autonomous mode");
    });

    it("rejects autonomy interval below minimum", () => {
      const settings = { ...validSettings, autonomyIntervalMs: 1000 };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("below minimum"))).toBe(true);
    });

    it("rejects autonomy interval above maximum", () => {
      const settings = { ...validSettings, autonomyIntervalMs: 5000000 };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds maximum"))).toBe(true);
    });

    it("rejects invalid LLM base URL", () => {
      const settings = { ...validSettings, llmBaseUrl: "not-a-url" };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not a valid HTTP/HTTPS URL"))).toBe(true);
    });

    it("rejects empty agent name", () => {
      const settings = { ...validSettings, agentName: "   " };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Agent name cannot be empty");
    });

    it("rejects negative max steps", () => {
      const settings = { ...validSettings, autonomyMaxSteps: -5 };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("cannot be negative"))).toBe(true);
    });

    it("rejects autonomous mode without model", () => {
      const settings = { ...validSettings, model: "" };
      const result = validateMoltbookSettings(settings);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("MODEL is required for autonomous mode");
    });
  });
});
