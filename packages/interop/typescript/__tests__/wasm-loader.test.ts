/**
 * Tests for WASM Plugin Loader
 */

import { describe, expect, test } from "vitest";
import type { PluginManifest, WasmPluginExports } from "../types";

// We need to test the loader logic without actual WASM files
// These tests validate the adapter patterns and JSON serialization

describe("WASM Loader", () => {
  describe("Plugin Manifest Parsing", () => {
    test("should parse a valid manifest JSON", () => {
      const manifestJson = JSON.stringify({
        name: "test-rust-plugin",
        description: "A test plugin compiled from Rust",
        version: "1.0.0",
        language: "rust",
        actions: [
          {
            name: "RUST_ACTION",
            description: "Action from Rust",
          },
        ],
        providers: [
          {
            name: "RUST_PROVIDER",
          },
        ],
      });

      const manifest: PluginManifest = JSON.parse(manifestJson);

      expect(manifest.name).toBe("test-rust-plugin");
      expect(manifest.language).toBe("rust");
      expect(manifest.actions?.length).toBe(1);
      expect(manifest.actions?.[0]?.name).toBe("RUST_ACTION");
    });
  });

  describe("Action Result Serialization", () => {
    test("should serialize and deserialize action results", () => {
      const result = {
        success: true,
        text: "Action completed successfully",
        data: {
          processed: true,
          count: 42,
        },
        values: {
          key: "value",
        },
      };

      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(true);
      expect(parsed.text).toBe("Action completed successfully");
      expect(parsed.data.processed).toBe(true);
      expect(parsed.data.count).toBe(42);
    });

    test("should handle failure results", () => {
      const result = {
        success: false,
        error: "Something went wrong",
      };

      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("Something went wrong");
    });
  });

  describe("Provider Result Serialization", () => {
    test("should serialize provider results with text", () => {
      const result = {
        text: "Provider context for the LLM",
        values: { template_var: "value" },
        data: { structured: "data" },
      };

      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.text).toBe("Provider context for the LLM");
      expect(parsed.values.template_var).toBe("value");
    });

    test("should handle empty provider results", () => {
      const result = {
        text: null,
        values: null,
        data: null,
      };

      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.text).toBeNull();
    });
  });

  describe("Memory Serialization", () => {
    test("should serialize memory objects for WASM", () => {
      const memory = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        agentId: "123e4567-e89b-12d3-a456-426614174001",
        entityId: "123e4567-e89b-12d3-a456-426614174002",
        roomId: "123e4567-e89b-12d3-a456-426614174003",
        content: {
          text: "Hello from TypeScript",
          actions: ["ACTION_1", "ACTION_2"],
          source: "test",
        },
        createdAt: Date.now(),
      };

      const json = JSON.stringify(memory);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe(memory.id);
      expect(parsed.content.text).toBe("Hello from TypeScript");
      expect(parsed.content.actions).toHaveLength(2);
    });
  });

  describe("State Serialization", () => {
    test("should serialize state objects for WASM", () => {
      const state = {
        text: "Current conversation context",
        values: {
          agentName: "TestAgent",
          userName: "TestUser",
          count: 5,
        },
        data: {
          providers: {
            time: { currentTime: "2024-01-01T00:00:00Z" },
          },
        },
      };

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      expect(parsed.text).toBe("Current conversation context");
      expect(parsed.values.agentName).toBe("TestAgent");
      expect(parsed.values.count).toBe(5);
    });

    test("should handle null state", () => {
      const json = JSON.stringify(null);
      expect(json).toBe("null");
    });
  });

  describe("WASM Export Interface", () => {
    // Mock WASM exports to test the expected interface
    test("should define expected export functions", () => {
      // This test validates the interface contract
      const mockExports: WasmPluginExports = {
        get_manifest: () =>
          JSON.stringify({ name: "test", description: "Test" }),
        init: (_config: string) => {},
        validate_action: (_action: string, _memory: string, _state: string) =>
          true,
        invoke_action: (
          _action: string,
          _memory: string,
          _state: string,
          _options: string,
        ) => JSON.stringify({ success: true }),
        get_provider: (_provider: string, _memory: string, _state: string) =>
          JSON.stringify({ text: "test" }),
        validate_evaluator: (
          _evaluator: string,
          _memory: string,
          _state: string,
        ) => false,
        invoke_evaluator: (
          _evaluator: string,
          _memory: string,
          _state: string,
        ) => "null",
        alloc: (_size: number) => 0,
        dealloc: (_ptr: number, _size: number) => {},
      };

      expect(typeof mockExports.get_manifest).toBe("function");
      expect(typeof mockExports.init).toBe("function");
      expect(typeof mockExports.validate_action).toBe("function");
      expect(typeof mockExports.invoke_action).toBe("function");
      expect(typeof mockExports.get_provider).toBe("function");
      expect(typeof mockExports.validate_evaluator).toBe("function");
      expect(typeof mockExports.invoke_evaluator).toBe("function");
      expect(typeof mockExports.alloc).toBe("function");
      expect(typeof mockExports.dealloc).toBe("function");
    });

    test("should get manifest from exports", () => {
      const manifest: PluginManifest = {
        name: "wasm-plugin",
        description: "WASM Plugin",
        version: "1.0.0",
        language: "rust",
        actions: [{ name: "TEST", description: "Test action" }],
      };

      const mockExports: Partial<WasmPluginExports> = {
        get_manifest: () => JSON.stringify(manifest),
      };

      if (!mockExports.get_manifest) {
        throw new Error("get_manifest not defined");
      }
      const result = JSON.parse(mockExports.get_manifest());
      expect(result.name).toBe("wasm-plugin");
      expect(result.actions[0].name).toBe("TEST");
    });

    test("should invoke action through exports", () => {
      const mockExports: Partial<WasmPluginExports> = {
        validate_action: (action, memory, _state) => {
          const memObj = JSON.parse(memory);
          return (
            action === "VALID_ACTION" &&
            memObj.content &&
            memObj.content.text !== undefined
          );
        },
        invoke_action: (action, memory, _state, _options) => {
          const memObj = JSON.parse(memory);
          return JSON.stringify({
            success: true,
            text: `Executed ${action} with: ${memObj.content?.text ? memObj.content.text : ""}`,
          });
        },
      };

      const memory = JSON.stringify({ content: { text: "Hello" } });
      const state = JSON.stringify({ values: {} });

      if (!mockExports.validate_action) {
        throw new Error("validate_action not defined");
      }
      expect(mockExports.validate_action("VALID_ACTION", memory, state)).toBe(
        true,
      );
      expect(mockExports.validate_action("INVALID_ACTION", memory, state)).toBe(
        false,
      );

      if (!mockExports.invoke_action) {
        throw new Error("invoke_action not defined");
      }
      const result = JSON.parse(
        mockExports.invoke_action("VALID_ACTION", memory, state, "{}"),
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain("Hello");
    });

    test("should get provider data through exports", () => {
      const mockExports: Partial<WasmPluginExports> = {
        get_provider: (provider, _memory, _state) => {
          if (provider === "TIME") {
            return JSON.stringify({
              text: "Current time is 12:00",
              values: { hour: 12 },
              data: { timezone: "UTC" },
            });
          }
          return JSON.stringify({ text: null, values: null, data: null });
        },
      };

      if (!mockExports.get_provider) {
        throw new Error("get_provider not defined");
      }
      const result = JSON.parse(mockExports.get_provider("TIME", "{}", "{}"));
      expect(result.text).toBe("Current time is 12:00");
      expect(result.values.hour).toBe(12);

      const emptyResult = JSON.parse(
        mockExports.get_provider("UNKNOWN", "{}", "{}"),
      );
      expect(emptyResult.text).toBeNull();
    });
  });

  describe("Plugin Adapter Creation", () => {
    test("should create action wrapper from manifest", () => {
      const manifest: PluginManifest = {
        name: "adapter-test",
        description: "Test",
        version: "1.0.0",
        language: "rust",
        actions: [
          {
            name: "ADAPTER_ACTION",
            description: "Test adapter action",
            similes: ["TEST_ADAPTER"],
          },
        ],
      };

      // Simulate what createPluginFromWasm does
      const actions = (manifest.actions ?? []).map((actionDef) => ({
        name: actionDef.name,
        description: actionDef.description,
        similes: actionDef.similes,
        validate: async () => true,
        handler: async () => ({ success: true, text: "Mock result" }),
      }));

      expect(actions).toHaveLength(1);
      expect(actions[0].name).toBe("ADAPTER_ACTION");
      expect(actions[0].similes).toContain("TEST_ADAPTER");
    });

    test("should create provider wrapper from manifest", () => {
      const manifest: PluginManifest = {
        name: "provider-test",
        description: "Test",
        version: "1.0.0",
        language: "rust",
        providers: [
          {
            name: "ADAPTER_PROVIDER",
            description: "Test provider",
            dynamic: true,
            position: 5,
          },
        ],
      };

      const providers = (manifest.providers ?? []).map((providerDef) => ({
        name: providerDef.name,
        description: providerDef.description,
        dynamic: providerDef.dynamic,
        position: providerDef.position,
        get: async () => ({ text: "Provider data" }),
      }));

      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("ADAPTER_PROVIDER");
      expect(providers[0].dynamic).toBe(true);
      expect(providers[0].position).toBe(5);
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid manifest JSON", () => {
      const invalidJson = "{ invalid json }";

      expect(() => JSON.parse(invalidJson)).toThrow();
    });

    test("should handle missing required fields", () => {
      const incompleteManifest = {
        name: "incomplete",
        // missing description
      };

      // Validation would fail at runtime
      expect(incompleteManifest.name).toBe("incomplete");
      expect(
        (incompleteManifest as PluginManifest).description,
      ).toBeUndefined();
    });

    test("should handle WASM invoke errors", () => {
      const mockExports: Partial<WasmPluginExports> = {
        invoke_action: () => {
          throw new Error("WASM execution failed");
        },
      };

      if (!mockExports.invoke_action) {
        throw new Error("invoke_action not defined");
      }
      expect(() =>
        mockExports.invoke_action("ACTION", "{}", "{}", "{}"),
      ).toThrow("WASM execution failed");
    });
  });
});
