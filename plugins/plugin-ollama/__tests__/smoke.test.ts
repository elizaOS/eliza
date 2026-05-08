import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  embed: vi.fn(),
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(() => ({
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  })),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => {
    const ollama = vi.fn((model: string) => ({ model }));
    return Object.assign(ollama, {
      embedding: vi.fn((model: string) => ({ model })),
    });
  }),
}));

vi.mock("../models/availability", () => ({
  ensureModelAvailable: vi.fn(async () => undefined),
}));

import plugin, { ollamaPlugin } from "../index";

describe("@elizaos/plugin-ollama", () => {
  it("exports the plugin as default", () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe("object");
  });

  it("exports the plugin as named export ollamaPlugin", () => {
    expect(ollamaPlugin).toBeDefined();
    expect(ollamaPlugin).toBe(plugin);
  });

  describe("plugin registration contract", () => {
    it("has a name", () => {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("ollama");
    });

    it("has a description", () => {
      expect(typeof plugin.description).toBe("string");
      expect(plugin.description.length).toBeGreaterThan(0);
    });

    it("has a config object with OLLAMA_API_ENDPOINT", () => {
      expect(plugin.config).toBeDefined();
      expect(typeof plugin.config).toBe("object");
      expect("OLLAMA_API_ENDPOINT" in (plugin.config as Record<string, unknown>)).toBe(true);
    });

    it("has an init function", () => {
      expect(typeof plugin.init).toBe("function");
    });

    it("has models map with required model types", () => {
      expect(plugin.models).toBeDefined();
      expect(typeof plugin.models).toBe("object");

      const modelKeys = Object.keys(plugin.models as Record<string, unknown>);
      expect(modelKeys.length).toBeGreaterThan(0);

      // Each model handler should be a function
      for (const key of modelKeys) {
        expect(typeof (plugin.models as Record<string, unknown>)[key]).toBe("function");
      }
    });

    it("registers TEXT_SMALL model handler", () => {
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_SMALL]).toBe("function");
    });

    it("registers TEXT_LARGE model handler", () => {
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_LARGE]).toBe("function");
    });

    it("registers OBJECT_SMALL and OBJECT_LARGE model handlers", () => {
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.OBJECT_SMALL]).toBe("function");
      expect(typeof models[ModelType.OBJECT_LARGE]).toBe("function");
    });

    it("registers TEXT_EMBEDDING model handler", () => {
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_EMBEDDING]).toBe("function");
    });

    it("has tests array with test suites", () => {
      expect(Array.isArray(plugin.tests)).toBe(true);
      expect(plugin.tests?.length).toBeGreaterThan(0);

      const suite = plugin.tests?.[0];
      expect(typeof suite.name).toBe("string");
      expect(suite.name).toBe("ollama_plugin_tests");
      expect(Array.isArray(suite.tests)).toBe(true);
      expect(suite.tests.length).toBeGreaterThan(0);

      for (const testCase of suite.tests) {
        expect(typeof testCase.name).toBe("string");
        expect(typeof testCase.fn).toBe("function");
      }
    });
  });
});
