import { describe, expect, it } from "vitest";
import { ollamaPlugin } from "../plugin.js";

describe("Ollama Plugin", () => {
  describe("Plugin metadata", () => {
    it("should have correct name", () => {
      expect(ollamaPlugin.name).toBe("ollama");
    });

    it("should have description", () => {
      expect(ollamaPlugin.description).toBeDefined();
      expect(ollamaPlugin.description).toContain("Ollama");
    });

    it("should have init function", () => {
      expect(ollamaPlugin.init).toBeDefined();
      expect(typeof ollamaPlugin.init).toBe("function");
    });

    it("should have config defined", () => {
      expect(ollamaPlugin.config).toBeDefined();
    });
  });

  describe("Config properties", () => {
    it("should have OLLAMA_API_ENDPOINT config", () => {
      expect("OLLAMA_API_ENDPOINT" in (ollamaPlugin.config ?? {})).toBe(true);
    });

    it("should have model config options", () => {
      const config = ollamaPlugin.config ?? {};
      expect("OLLAMA_SMALL_MODEL" in config).toBe(true);
      expect("OLLAMA_LARGE_MODEL" in config).toBe(true);
      expect("OLLAMA_EMBEDDING_MODEL" in config).toBe(true);
    });
  });

  describe("Model handlers", () => {
    it("should have models object defined", () => {
      expect(ollamaPlugin.models).toBeDefined();
    });

    it("should have TEXT_EMBEDDING model handler", () => {
      expect(ollamaPlugin.models?.TEXT_EMBEDDING).toBeDefined();
      expect(typeof ollamaPlugin.models?.TEXT_EMBEDDING).toBe("function");
    });

    it("should have TEXT_SMALL model handler", () => {
      expect(ollamaPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof ollamaPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", () => {
      expect(ollamaPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof ollamaPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have OBJECT_SMALL model handler", () => {
      expect(ollamaPlugin.models?.OBJECT_SMALL).toBeDefined();
      expect(typeof ollamaPlugin.models?.OBJECT_SMALL).toBe("function");
    });

    it("should have OBJECT_LARGE model handler", () => {
      expect(ollamaPlugin.models?.OBJECT_LARGE).toBeDefined();
      expect(typeof ollamaPlugin.models?.OBJECT_LARGE).toBe("function");
    });
  });

  describe("Plugin tests", () => {
    it("should have inline tests defined", () => {
      expect(ollamaPlugin.tests).toBeDefined();
      expect(Array.isArray(ollamaPlugin.tests)).toBe(true);
    });

    it("should have ollama_plugin_tests test suite", () => {
      const testSuite = ollamaPlugin.tests?.find((t) => t.name === "ollama_plugin_tests");
      expect(testSuite).toBeDefined();
    });

    it("should have URL validation test", () => {
      const testSuite = ollamaPlugin.tests?.find((t) => t.name === "ollama_plugin_tests");
      const urlTest = testSuite?.tests.find((t) => t.name === "ollama_test_url_validation");
      expect(urlTest).toBeDefined();
    });

    it("should have text embedding test", () => {
      const testSuite = ollamaPlugin.tests?.find((t) => t.name === "ollama_plugin_tests");
      const embeddingTest = testSuite?.tests.find((t) => t.name === "ollama_test_text_embedding");
      expect(embeddingTest).toBeDefined();
    });
  });
});
