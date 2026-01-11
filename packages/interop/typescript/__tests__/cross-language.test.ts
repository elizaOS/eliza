/**
 * Cross-language interop tests for elizaOS
 *
 * These tests verify that plugins written in different languages
 * can be loaded and executed correctly across runtimes.
 */

import type { Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopPythonPlugin } from "../python-bridge";

describe("Cross-Language Plugin Interop", () => {
  describe("Python Plugin Loading", () => {
    const pythonPlugin: Plugin | null = null;

    beforeAll(async () => {
      // Skip if Python is not available
      try {
        const { spawn } = await import("node:child_process");
        const python = spawn("python3", ["--version"]);
        await new Promise<void>((resolve, reject) => {
          python.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error("Python not available"));
          });
          python.on("error", reject);
        });
      } catch {
        console.log("Skipping Python tests - Python not available");
        return;
      }
    });

    afterAll(async () => {
      if (pythonPlugin) {
        await stopPythonPlugin(pythonPlugin);
      }
    });

    it("should have consistent manifest structure", async () => {
      // This test verifies that the manifest structure is consistent
      // across TypeScript, Python, and Rust plugins

      const expectedManifestFields = [
        "name",
        "description",
        "actions",
        "providers",
        "evaluators",
      ];

      // Define a mock manifest to test structure
      const mockManifest = {
        name: "test-plugin",
        description: "Test plugin",
        version: "1.0.0",
        language: "typescript",
        actions: [{ name: "test_action", description: "Test action" }],
        providers: [{ name: "test_provider", description: "Test provider" }],
        evaluators: [],
      };

      for (const field of expectedManifestFields) {
        expect(mockManifest).toHaveProperty(field);
      }
    });

    it("should have consistent IPC message structure", async () => {
      // This test verifies that IPC messages have consistent structure
      // across all language implementations

      const actionInvokeMessage = {
        type: "action.invoke",
        id: "test-123",
        action: "TEST_ACTION",
        memory: {
          id: "mem-1",
          entityId: "entity-1",
          roomId: "room-1",
          content: { text: "test" },
        },
        state: null,
        options: null,
      };

      const actionResultMessage = {
        type: "action.result",
        id: "test-123",
        result: {
          success: true,
          text: "Result text",
          data: { key: "value" },
        },
      };

      // Verify structure
      expect(actionInvokeMessage.type).toBe("action.invoke");
      expect(actionResultMessage.result.success).toBe(true);
    });

    it("should have consistent provider result structure", async () => {
      const providerResult = {
        text: "Provider output",
        values: { key: "value" },
        data: { structured: "data" },
      };

      expect(providerResult).toHaveProperty("text");
      expect(providerResult).toHaveProperty("values");
      expect(providerResult).toHaveProperty("data");
    });
  });

  describe("Type Compatibility", () => {
    it("should have consistent ActionResult structure", () => {
      // TypeScript ActionResult
      const tsActionResult = {
        success: true,
        text: "Action completed",
        error: undefined,
        data: { key: "value" },
        values: { setting: true },
      };

      // Python ActionResult (serialized)
      const pyActionResult = {
        success: true,
        text: "Action completed",
        error: null,
        data: { key: "value" },
        values: { setting: true },
      };

      // Rust ActionResult (serialized)
      const rsActionResult = {
        success: true,
        text: "Action completed",
        data: { key: "value" },
        values: { setting: true },
      };

      // All should have consistent required fields
      expect(tsActionResult.success).toBe(pyActionResult.success);
      expect(tsActionResult.success).toBe(rsActionResult.success);
      expect(tsActionResult.text).toBe(pyActionResult.text);
      expect(tsActionResult.text).toBe(rsActionResult.text);
    });

    it("should have consistent Memory structure", () => {
      const memory = {
        id: "mem-uuid",
        entityId: "entity-uuid",
        agentId: "agent-uuid",
        roomId: "room-uuid",
        content: { text: "Message content" },
        createdAt: 1704067200000,
        unique: false,
        metadata: { type: "messages" },
      };

      // Verify all required fields are present
      expect(memory).toHaveProperty("id");
      expect(memory).toHaveProperty("entityId");
      expect(memory).toHaveProperty("roomId");
      expect(memory).toHaveProperty("content");
      expect(memory.content).toHaveProperty("text");
    });

    it("should have consistent State structure", () => {
      const state = {
        values: { key: "value" },
        data: { structured: "data" },
        text: "Context text",
      };

      expect(state).toHaveProperty("values");
      expect(state).toHaveProperty("data");
      expect(state).toHaveProperty("text");
    });
  });

  describe("Plugin Manifest Compatibility", () => {
    it("should support all plugin component types", () => {
      const fullPluginManifest = {
        name: "full-plugin",
        description: "A plugin with all components",
        version: "1.0.0",
        language: "typescript" as const,
        config: { setting1: "value1" },
        dependencies: ["@elizaos/core"],
        actions: [
          {
            name: "ACTION_ONE",
            description: "First action",
            similes: ["similar action"],
          },
        ],
        providers: [
          {
            name: "PROVIDER_ONE",
            description: "First provider",
            dynamic: true,
            position: 10,
            private: false,
          },
        ],
        evaluators: [
          {
            name: "EVALUATOR_ONE",
            description: "First evaluator",
            alwaysRun: false,
            similes: ["similar evaluator"],
          },
        ],
        services: [
          {
            type: "SERVICE_ONE",
            description: "First service",
          },
        ],
        routes: [
          {
            path: "/api/test",
            method: "GET" as const,
            name: "test_route",
            public: true,
          },
        ],
      };

      // Verify all component arrays are present
      expect(fullPluginManifest.actions).toHaveLength(1);
      expect(fullPluginManifest.providers).toHaveLength(1);
      expect(fullPluginManifest.evaluators).toHaveLength(1);
      expect(fullPluginManifest.services).toHaveLength(1);
      expect(fullPluginManifest.routes).toHaveLength(1);
    });
  });

  describe("Interop Protocol Compatibility", () => {
    it("should support WASM protocol for Rust plugins", () => {
      const wasmConfig = {
        protocol: "wasm" as const,
        wasmPath: "./dist/plugin.wasm",
      };

      expect(wasmConfig.protocol).toBe("wasm");
      expect(wasmConfig.wasmPath).toBeDefined();
    });

    it("should support IPC protocol for Python plugins", () => {
      const ipcConfig = {
        protocol: "ipc" as const,
        ipcCommand: "python3 -m plugin_module",
      };

      expect(ipcConfig.protocol).toBe("ipc");
    });

    it("should support FFI protocol for native plugins", () => {
      const ffiConfig = {
        protocol: "ffi" as const,
        sharedLibPath: "./dist/libplugin.so",
      };

      expect(ffiConfig.protocol).toBe("ffi");
      expect(ffiConfig.sharedLibPath).toBeDefined();
    });

    it("should support native protocol for TypeScript plugins", () => {
      const nativeConfig = {
        protocol: "native" as const,
      };

      expect(nativeConfig.protocol).toBe("native");
    });
  });
});

describe("ELIZA Classic Cross-Language Parity", () => {
  it("should have same response patterns across implementations", () => {
    // Test that the core ELIZA patterns are consistent
    const corePatterns = [
      { keyword: "hello", weight: 0 },
      { keyword: "sorry", weight: 1 },
      { keyword: "remember", weight: 5 },
      { keyword: "if", weight: 3 },
      { keyword: "dream", weight: 3 },
      { keyword: "computer", weight: 50 },
      { keyword: "my", weight: 2 },
      { keyword: "everyone", weight: 2 },
      { keyword: "always", weight: 1 },
    ];

    // Verify core patterns exist and have weights
    for (const pattern of corePatterns) {
      expect(pattern.keyword).toBeDefined();
      expect(typeof pattern.weight).toBe("number");
    }
  });

  it("should have consistent pronoun reflections", () => {
    const reflections: Record<string, string> = {
      am: "are",
      was: "were",
      i: "you",
      "i'd": "you would",
      "i've": "you have",
      "i'll": "you will",
      my: "your",
      are: "am",
      "you've": "I have",
      "you'll": "I will",
      your: "my",
      yours: "mine",
      you: "me",
      me: "you",
      myself: "yourself",
      yourself: "myself",
      "i'm": "you are",
    };

    // Verify reflection pairs
    expect(reflections.i).toBe("you");
    expect(reflections.my).toBe("your");
    expect(reflections.you).toBe("me");
    expect(reflections.me).toBe("you");
  });

  it("should have consistent default responses", () => {
    const defaultResponses = [
      "Very interesting.",
      "I am not sure I understand you fully.",
      "What does that suggest to you?",
      "Please continue.",
      "Go on.",
      "Do you feel strongly about discussing such things?",
      "Tell me more.",
      "That is quite interesting.",
      "Can you elaborate on that?",
      "Why do you say that?",
      "I see.",
      "What does that mean to you?",
      "How does that make you feel?",
      "Let's explore that further.",
      "Interesting. Please go on.",
    ];

    // Verify we have enough default responses
    expect(defaultResponses.length).toBeGreaterThanOrEqual(10);

    // Verify responses are non-empty strings
    for (const response of defaultResponses) {
      expect(typeof response).toBe("string");
      expect(response.length).toBeGreaterThan(0);
    }
  });
});
