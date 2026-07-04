/**
 * Live integration smoke test hitting the real Google Generative Language API
 * directly (model list, text generation, embeddings, JSON output). Self-skips
 * when `GOOGLE_GENERATIVE_AI_API_KEY` is unset.
 */
import { config } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";

config();

const hasApiKey = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;

describe("Google GenAI Integration", () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.log(
        "Google GenAI live integration tests require GOOGLE_GENERATIVE_AI_API_KEY",
      );
    }
  });

  describe.skipIf(!hasApiKey)("API Integration", () => {
    it("should validate API key by listing models", async () => {
      const { GoogleGenAI } = await import("@google/genai");

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      expect(apiKey).toBeDefined();
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      }

      const genAI = new GoogleGenAI({ apiKey });
      const modelList = await genAI.models.list();

      const models = [];
      for await (const model of modelList) {
        models.push(model);
      }

      expect(models.length).toBeGreaterThan(0);
    });

    it("should generate text with small model", async () => {
      const { GoogleGenAI } = await import("@google/genai");

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      }
      const genAI = new GoogleGenAI({ apiKey });

      const response = await genAI.models.generateContent({
        model: "gemini-2.0-flash-001",
        contents: "What is 2+2? Answer with just the number.",
        config: {
          maxOutputTokens: 10,
        },
      });

      expect(response.text).toBeDefined();
      expect(response.text).toContain("4");
    });

    it("should generate embeddings", async () => {
      const { GoogleGenAI } = await import("@google/genai");

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      }
      const genAI = new GoogleGenAI({ apiKey });

      const response = await genAI.models.embedContent({
        model: "text-embedding-004",
        contents: "Hello, world!",
      });

      expect(response.embeddings).toBeDefined();
      expect(response.embeddings?.length).toBeGreaterThan(0);
      expect(response.embeddings?.[0]?.values?.length).toBeGreaterThan(0);
    });

    it("should generate JSON object", async () => {
      const { GoogleGenAI } = await import("@google/genai");

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      }
      const genAI = new GoogleGenAI({ apiKey });

      const response = await genAI.models.generateContent({
        model: "gemini-2.0-flash-001",
        contents:
          'Create a JSON object with a "greeting" field that says "hello".',
        config: {
          responseMimeType: "application/json",
        },
      });

      expect(response.text).toBeDefined();

      const parsed = JSON.parse(response.text || "{}");
      expect(parsed).toBeDefined();
    });
  });
});
