import { describe, expect, it } from "vitest";
import { localAiPlugin } from "../index.js";

describe("Local AI Plugin", () => {
  describe("Plugin metadata", () => {
    it("should have correct name", () => {
      expect(localAiPlugin.name).toBe("local-ai");
    });

    it("should have description", () => {
      expect(localAiPlugin.description).toBeDefined();
      expect(localAiPlugin.description).toContain("Local AI");
    });

    it("should have init function", () => {
      expect(localAiPlugin.init).toBeDefined();
      expect(typeof localAiPlugin.init).toBe("function");
    });
  });

  describe("Model handlers", () => {
    it("should have models object defined", () => {
      expect(localAiPlugin.models).toBeDefined();
    });

    it("should have TEXT_SMALL model handler", () => {
      expect(localAiPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", () => {
      expect(localAiPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have TEXT_EMBEDDING model handler", () => {
      expect(localAiPlugin.models?.TEXT_EMBEDDING).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_EMBEDDING).toBe("function");
    });

    it("should have OBJECT_SMALL model handler", () => {
      expect(localAiPlugin.models?.OBJECT_SMALL).toBeDefined();
      expect(typeof localAiPlugin.models?.OBJECT_SMALL).toBe("function");
    });

    it("should have OBJECT_LARGE model handler", () => {
      expect(localAiPlugin.models?.OBJECT_LARGE).toBeDefined();
      expect(typeof localAiPlugin.models?.OBJECT_LARGE).toBe("function");
    });

    it("should have TEXT_TOKENIZER_ENCODE model handler", () => {
      expect(localAiPlugin.models?.TEXT_TOKENIZER_ENCODE).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_TOKENIZER_ENCODE).toBe("function");
    });

    it("should have TEXT_TOKENIZER_DECODE model handler", () => {
      expect(localAiPlugin.models?.TEXT_TOKENIZER_DECODE).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_TOKENIZER_DECODE).toBe("function");
    });

    it("should have IMAGE_DESCRIPTION model handler", () => {
      expect(localAiPlugin.models?.IMAGE_DESCRIPTION).toBeDefined();
      expect(typeof localAiPlugin.models?.IMAGE_DESCRIPTION).toBe("function");
    });

    it("should have TRANSCRIPTION model handler", () => {
      expect(localAiPlugin.models?.TRANSCRIPTION).toBeDefined();
      expect(typeof localAiPlugin.models?.TRANSCRIPTION).toBe("function");
    });

    it("should have TEXT_TO_SPEECH model handler", () => {
      expect(localAiPlugin.models?.TEXT_TO_SPEECH).toBeDefined();
      expect(typeof localAiPlugin.models?.TEXT_TO_SPEECH).toBe("function");
    });
  });

  describe("Plugin tests", () => {
    it("should have inline tests defined", () => {
      expect(localAiPlugin.tests).toBeDefined();
      expect(Array.isArray(localAiPlugin.tests)).toBe(true);
    });

    it("should have local_ai_plugin_tests test suite", () => {
      const testSuite = localAiPlugin.tests?.find((t) => t.name === "local_ai_plugin_tests");
      expect(testSuite).toBeDefined();
    });

    it("should have initialization test", () => {
      const testSuite = localAiPlugin.tests?.find((t) => t.name === "local_ai_plugin_tests");
      const initTest = testSuite?.tests.find((t) => t.name === "local_ai_test_initialization");
      expect(initTest).toBeDefined();
    });
  });
});
