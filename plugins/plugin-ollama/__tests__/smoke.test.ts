import { beforeAll, describe, expect, it } from "vitest";

type OllamaPluginModule = typeof import("../index.ts");

describe("@elizaos/plugin-ollama", () => {
  let mod: OllamaPluginModule;

  beforeAll(async () => {
    mod = await import("../index.ts");
  }, 120_000);

  it("exports the plugin as default", () => {
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("object");
  });

  it("exports the plugin as named export ollamaPlugin", () => {
    expect(mod.ollamaPlugin).toBeDefined();
    expect(mod.ollamaPlugin).toBe(mod.default);
  });

  describe("plugin registration contract", () => {
    it("has a name", () => {
      const { default: plugin } = mod;
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("ollama");
    });

    it("has a description", () => {
      const { default: plugin } = mod;
      expect(typeof plugin.description).toBe("string");
      expect(plugin.description.length).toBeGreaterThan(0);
    });

    it("has a config object with OLLAMA_API_ENDPOINT", () => {
      const { default: plugin } = mod;
      expect(plugin.config).toBeDefined();
      expect(typeof plugin.config).toBe("object");
      expect("OLLAMA_API_ENDPOINT" in (plugin.config as Record<string, unknown>)).toBe(true);
    });

    it("has an init function", () => {
      const { default: plugin } = mod;
      expect(typeof plugin.init).toBe("function");
    });

    it("has models map with required model types", () => {
      const { default: plugin } = mod;
      expect(plugin.models).toBeDefined();
      expect(typeof plugin.models).toBe("object");

      const modelKeys = Object.keys(plugin.models as Record<string, unknown>);
      expect(modelKeys.length).toBeGreaterThan(0);

      // Each model handler should be a function
      for (const key of modelKeys) {
        expect(typeof (plugin.models as Record<string, unknown>)[key]).toBe("function");
      }
    });

    it("registers TEXT_SMALL model handler", async () => {
      const { default: plugin } = mod;
      const { ModelType } = await import("@elizaos/core");
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_SMALL]).toBe("function");
    });

    it("registers TEXT_LARGE model handler", async () => {
      const { default: plugin } = mod;
      const { ModelType } = await import("@elizaos/core");
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_LARGE]).toBe("function");
    });

    it("registers OBJECT_SMALL and OBJECT_LARGE model handlers", async () => {
      const { default: plugin } = mod;
      const { ModelType } = await import("@elizaos/core");
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.OBJECT_SMALL]).toBe("function");
      expect(typeof models[ModelType.OBJECT_LARGE]).toBe("function");
    });

    it("registers TEXT_EMBEDDING model handler", async () => {
      const { default: plugin } = mod;
      const { ModelType } = await import("@elizaos/core");
      const models = plugin.models as Record<string, unknown>;
      expect(typeof models[ModelType.TEXT_EMBEDDING]).toBe("function");
    });

    it("has tests array with test suites", () => {
      const { default: plugin } = mod;
      expect(Array.isArray(plugin.tests)).toBe(true);
      expect(plugin.tests!.length).toBeGreaterThan(0);

      const suite = plugin.tests![0];
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
