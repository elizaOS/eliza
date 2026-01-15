/**
 * Unit tests for the OpenAI plugin.
 */

import { describe, expect, it } from "vitest";

describe("OpenAI Plugin", () => {
  describe("Plugin Definition", () => {
    it("should have correct plugin name", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.name).toBe("openai");
    });

    it("should have plugin description", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.description).toBeDefined();
      expect(openaiPlugin.description.length).toBeGreaterThan(0);
    });

    it("should have models registered", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models).toBeDefined();
      expect(Object.keys(openaiPlugin.models ?? {}).length).toBeGreaterThan(0);
    });

    it("should have test suites defined", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.tests).toBeDefined();
      expect(openaiPlugin.tests?.length).toBeGreaterThan(0);
    });
  });

  describe("Config", () => {
    it("should have config options defined", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.config).toBeDefined();
      expect(openaiPlugin.config?.OPENAI_API_KEY).toBeDefined;
    });

    it("should have all expected config keys", async () => {
      const { openaiPlugin } = await import("../index");
      const config = openaiPlugin.config;
      expect(config).toHaveProperty("OPENAI_API_KEY");
      expect(config).toHaveProperty("OPENAI_BASE_URL");
      expect(config).toHaveProperty("OPENAI_SMALL_MODEL");
      expect(config).toHaveProperty("OPENAI_LARGE_MODEL");
      expect(config).toHaveProperty("OPENAI_EMBEDDING_MODEL");
      expect(config).toHaveProperty("OPENAI_RESEARCH_MODEL");
      expect(config).toHaveProperty("OPENAI_RESEARCH_TIMEOUT");
    });
  });

  describe("Model Handlers", () => {
    it("should have TEXT_EMBEDDING model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_EMBEDDING).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_EMBEDDING).toBe("function");
    });

    it("should have TEXT_SMALL model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have IMAGE model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.IMAGE).toBeDefined();
      expect(typeof openaiPlugin.models?.IMAGE).toBe("function");
    });

    it("should have IMAGE_DESCRIPTION model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.IMAGE_DESCRIPTION).toBeDefined();
      expect(typeof openaiPlugin.models?.IMAGE_DESCRIPTION).toBe("function");
    });

    it("should have TRANSCRIPTION model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TRANSCRIPTION).toBeDefined();
      expect(typeof openaiPlugin.models?.TRANSCRIPTION).toBe("function");
    });

    it("should have TEXT_TO_SPEECH model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_TO_SPEECH).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_TO_SPEECH).toBe("function");
    });

    it("should have OBJECT_SMALL model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.OBJECT_SMALL).toBeDefined();
      expect(typeof openaiPlugin.models?.OBJECT_SMALL).toBe("function");
    });

    it("should have OBJECT_LARGE model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.OBJECT_LARGE).toBeDefined();
      expect(typeof openaiPlugin.models?.OBJECT_LARGE).toBe("function");
    });

    it("should have RESEARCH model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.RESEARCH).toBeDefined();
      expect(typeof openaiPlugin.models?.RESEARCH).toBe("function");
    });

    it("should have TEXT_TOKENIZER_ENCODE model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_TOKENIZER_ENCODE).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_TOKENIZER_ENCODE).toBe("function");
    });

    it("should have TEXT_TOKENIZER_DECODE model handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_TOKENIZER_DECODE).toBeDefined();
      expect(typeof openaiPlugin.models?.TEXT_TOKENIZER_DECODE).toBe("function");
    });
  });

  describe("Init Function", () => {
    it("should have an init function", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.init).toBeDefined();
      expect(typeof openaiPlugin.init).toBe("function");
    });
  });
});
