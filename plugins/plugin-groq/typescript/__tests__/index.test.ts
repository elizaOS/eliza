import { describe, expect, it } from "vitest";
import { groqPlugin } from "../index.js";

describe("Groq Plugin", () => {
  describe("Plugin metadata", () => {
    it("should have correct name", () => {
      expect(groqPlugin.name).toBe("groq");
    });

    it("should have description", () => {
      expect(groqPlugin.description).toBeDefined();
      expect(groqPlugin.description).toContain("Groq");
    });

    it("should have init function", () => {
      expect(groqPlugin.init).toBeDefined();
      expect(typeof groqPlugin.init).toBe("function");
    });
  });

  describe("Model handlers", () => {
    it("should have models object defined", () => {
      expect(groqPlugin.models).toBeDefined();
    });

    it("should have TEXT_SMALL model handler", () => {
      expect(groqPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof groqPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", () => {
      expect(groqPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof groqPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have OBJECT_SMALL model handler", () => {
      expect(groqPlugin.models?.OBJECT_SMALL).toBeDefined();
      expect(typeof groqPlugin.models?.OBJECT_SMALL).toBe("function");
    });

    it("should have OBJECT_LARGE model handler", () => {
      expect(groqPlugin.models?.OBJECT_LARGE).toBeDefined();
      expect(typeof groqPlugin.models?.OBJECT_LARGE).toBe("function");
    });

    it("should have TRANSCRIPTION model handler", () => {
      expect(groqPlugin.models?.TRANSCRIPTION).toBeDefined();
      expect(typeof groqPlugin.models?.TRANSCRIPTION).toBe("function");
    });

    it("should have TEXT_TO_SPEECH model handler", () => {
      expect(groqPlugin.models?.TEXT_TO_SPEECH).toBeDefined();
      expect(typeof groqPlugin.models?.TEXT_TO_SPEECH).toBe("function");
    });
  });

  describe("Plugin tests", () => {
    it("should have inline tests defined", () => {
      expect(groqPlugin.tests).toBeDefined();
      expect(Array.isArray(groqPlugin.tests)).toBe(true);
    });

    it("should have groq_plugin_tests test suite", () => {
      const testSuite = groqPlugin.tests?.find((t) => t.name === "groq_plugin_tests");
      expect(testSuite).toBeDefined();
    });

    it("should have validate_api_key test", () => {
      const testSuite = groqPlugin.tests?.find((t) => t.name === "groq_plugin_tests");
      const apiKeyTest = testSuite?.tests.find((t) => t.name === "validate_api_key");
      expect(apiKeyTest).toBeDefined();
    });
  });
});
