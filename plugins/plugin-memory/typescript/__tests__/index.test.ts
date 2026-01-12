import { describe, expect, it } from "vitest";
import { memoryPlugin } from "../src/index.js";

describe("Memory Plugin", () => {
  describe("Plugin metadata", () => {
    it("should have correct name", () => {
      expect(memoryPlugin.name).toBe("memory");
    });

    it("should have description", () => {
      expect(memoryPlugin.description).toBeDefined();
      expect(memoryPlugin.description).toContain("memory");
    });
  });

  describe("Services", () => {
    it("should have services defined", () => {
      expect(memoryPlugin.services).toBeDefined();
      expect(Array.isArray(memoryPlugin.services)).toBe(true);
    });

    it("should have at least one service", () => {
      expect(memoryPlugin.services?.length).toBeGreaterThan(0);
    });
  });

  describe("Evaluators", () => {
    it("should have evaluators defined", () => {
      expect(memoryPlugin.evaluators).toBeDefined();
      expect(Array.isArray(memoryPlugin.evaluators)).toBe(true);
    });

    it("should have summarization evaluator", () => {
      const summarizationEval = memoryPlugin.evaluators?.find((e) =>
        e.name?.toLowerCase().includes("summariz")
      );
      expect(summarizationEval).toBeDefined();
    });

    it("should have long-term extraction evaluator", () => {
      const longTermEval = memoryPlugin.evaluators?.find(
        (e) => e.name?.toLowerCase().includes("long") || e.name?.toLowerCase().includes("extract")
      );
      expect(longTermEval).toBeDefined();
    });
  });

  describe("Providers", () => {
    it("should have providers defined", () => {
      expect(memoryPlugin.providers).toBeDefined();
      expect(Array.isArray(memoryPlugin.providers)).toBe(true);
    });

    it("should have at least two providers", () => {
      expect(memoryPlugin.providers?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Schema", () => {
    it("should have schema defined", () => {
      expect(memoryPlugin.schema).toBeDefined();
    });
  });
});
