import { ModelType } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";

type TestCase = {
  name?: unknown;
  fn?: unknown;
};

type TestSuite = {
  name?: unknown;
  tests?: TestCase[];
};

type PluginShape = {
  name?: unknown;
  description?: unknown;
  config?: unknown;
  init?: unknown;
  models?: Record<string, unknown>;
  tests?: TestSuite[];
};

let plugin: PluginShape;
let namedPlugin: PluginShape | undefined;

beforeAll(async () => {
  const mod = await import("../index");
  plugin = mod.default;
  namedPlugin = mod.groqPlugin;
}, 120_000);

describe("@elizaos/plugin-groq", () => {
  it("exports the plugin as default", () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe("object");
  });

  it("exports the plugin as named export groqPlugin", () => {
    expect(namedPlugin).toBeDefined();
    expect(namedPlugin).toBe(plugin);
  });

  describe("plugin registration contract", () => {
    it("has a name", () => {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("groq");
    });

    it("has a description", () => {
      expect(typeof plugin.description).toBe("string");
      expect((plugin.description as string).length).toBeGreaterThan(0);
    });

    it("has a config object with GROQ_API_KEY", () => {
      expect(plugin.config).toBeDefined();
      expect(typeof plugin.config).toBe("object");
      expect("GROQ_API_KEY" in (plugin.config as Record<string, unknown>)).toBe(true);
    });

    it("has an init function", () => {
      expect(typeof plugin.init).toBe("function");
    });

    it("has models map with required model types", () => {
      expect(plugin.models).toBeDefined();
      expect(typeof plugin.models).toBe("object");

      const modelKeys = Object.keys(plugin.models ?? {});
      expect(modelKeys.length).toBeGreaterThan(0);

      for (const key of modelKeys) {
        expect(typeof plugin.models?.[key]).toBe("function");
      }
    });

    it("registers TEXT_SMALL model handler", () => {
      expect(typeof plugin.models?.[ModelType.TEXT_SMALL]).toBe("function");
    });

    it("registers TEXT_LARGE model handler", () => {
      expect(typeof plugin.models?.[ModelType.TEXT_LARGE]).toBe("function");
    });

    it("registers TRANSCRIPTION model handler", () => {
      expect(typeof plugin.models?.[ModelType.TRANSCRIPTION]).toBe("function");
    });

    it("registers TEXT_TO_SPEECH model handler", () => {
      expect(typeof plugin.models?.[ModelType.TEXT_TO_SPEECH]).toBe("function");
    });

    it("registers RESPONSE_HANDLER and ACTION_PLANNER model handlers", () => {
      expect(typeof plugin.models?.[ModelType.RESPONSE_HANDLER]).toBe("function");
      expect(typeof plugin.models?.[ModelType.ACTION_PLANNER]).toBe("function");
    });

    it("has tests array with test suites", () => {
      expect(Array.isArray(plugin.tests)).toBe(true);
      expect(plugin.tests?.length).toBeGreaterThan(0);

      const suite = plugin.tests?.[0];
      expect(typeof suite.name).toBe("string");
      expect(suite.name).toBe("groq_plugin_tests");
      expect(Array.isArray(suite.tests)).toBe(true);
      expect(suite.tests.length).toBeGreaterThan(0);

      for (const testCase of suite.tests) {
        expect(typeof testCase.name).toBe("string");
        expect(typeof testCase.fn).toBe("function");
      }
    });
  });
});
