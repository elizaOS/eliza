import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { configSchema } from "../environment.js";
import { localAiPlugin } from "../index.js";
import { MODEL_SPECS } from "../types.js";

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

  describe("Eliza-1 defaults", () => {
    it("uses canonical 0_8b, 2b, and 4b local defaults", () => {
      const parsed = configSchema.parse({});

      expect(parsed.LOCAL_SMALL_MODEL).toBe("text/eliza-1-2b-32k.gguf");
      expect(parsed.LOCAL_LARGE_MODEL).toBe("text/eliza-1-4b-64k.gguf");
      expect(parsed.LOCAL_EMBEDDING_MODEL).toBe("text/eliza-1-0_8b-32k.gguf");
      expect(MODEL_SPECS.small.name).toBe("text/eliza-1-2b-32k.gguf");
      expect(MODEL_SPECS.medium.name).toBe("text/eliza-1-4b-64k.gguf");
      expect(MODEL_SPECS.embedding.name).toBe("text/eliza-1-0_8b-32k.gguf");
    });

    it("does not default local TTS to a Transformers.js model", () => {
      expect(MODEL_SPECS.tts.default.repo).toBe("elizaos/eliza-1");
      expect(MODEL_SPECS.tts.default.name).toBe("tts/omnivoice-small.gguf");
      expect("modelId" in MODEL_SPECS.tts.default).toBe(false);
      expect("defaultSpeakerEmbeddingUrl" in MODEL_SPECS.tts.default).toBe(false);
    });
  });

  describe("local-inference compatibility routing", () => {
    it("routes plain text generation to an active unified local-inference backend", async () => {
      const runtime = {
        getService: () => ({
          generate: async ({ prompt }: { prompt: string }) => `unified:${prompt}`,
        }),
      };

      const result = await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(runtime as never, {
        prompt: "hello",
      });

      expect(result).toBe("unified:hello");
    });

    it("routes TTS to an active unified local-inference backend", async () => {
      const audio = new Uint8Array([1, 2, 3]);
      const runtime = {
        getService: () => ({
          synthesizeSpeech: async () => audio,
        }),
      };

      const result = await localAiPlugin.models?.[ModelType.TEXT_TO_SPEECH]?.(
        runtime as never,
        "hello"
      );

      expect(result).toEqual(audio);
    });

    it("routes image description to an active unified local-inference backend", async () => {
      const runtime = {
        getService: () => ({
          describeImage: async () => ({
            title: "A device",
            description: "A device running Eliza-1.",
          }),
        }),
      };

      const result = await localAiPlugin.models?.[ModelType.IMAGE_DESCRIPTION]?.(runtime as never, {
        imageUrl: "data:image/png;base64,AAAA",
      });

      expect(result).toEqual({
        title: "A device",
        description: "A device running Eliza-1.",
      });
    });

    it("blocks the legacy Florence vision path unless explicitly opted in", async () => {
      const previous = process.env.LOCAL_AI_ENABLE_LEGACY_VISION;
      delete process.env.LOCAL_AI_ENABLE_LEGACY_VISION;
      try {
        await expect(
          localAiPlugin.models?.[ModelType.IMAGE_DESCRIPTION]?.({} as never, {
            imageUrl: "data:image/png;base64,AAAA",
          })
        ).rejects.toThrow(/legacy Florence/);
      } finally {
        if (previous === undefined) delete process.env.LOCAL_AI_ENABLE_LEGACY_VISION;
        else process.env.LOCAL_AI_ENABLE_LEGACY_VISION = previous;
      }
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
