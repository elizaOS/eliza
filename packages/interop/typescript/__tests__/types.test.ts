/**
 * Tests for interop types
 */

import type { Memory, State, UUID } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import type {
  ActionInvokeRequest,
  ActionManifest,
  ActionResultResponse,
  InteropProtocol,
  PluginLanguage,
  PluginManifest,
  ProviderGetRequest,
  ProviderManifest,
  ProviderResultResponse,
} from "../types";

describe("Interop Types", () => {
  describe("PluginManifest", () => {
    test("should validate complete manifest structure", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        description: "A test plugin",
        version: "1.0.0",
        language: "rust",
        interop: {
          protocol: "wasm",
          wasmPath: "./dist/test.wasm",
        },
        config: {
          API_KEY: "test-key",
        },
        dependencies: ["other-plugin"],
        actions: [
          {
            name: "TEST_ACTION",
            description: "Test action",
            similes: ["TEST", "TESTING"],
          },
        ],
        providers: [
          {
            name: "TEST_PROVIDER",
            description: "Test provider",
            dynamic: true,
            position: 1,
            private: false,
          },
        ],
        evaluators: [
          {
            name: "TEST_EVALUATOR",
            description: "Test evaluator",
            alwaysRun: true,
            similes: ["EVALUATE"],
          },
        ],
        services: [
          {
            type: "test-service",
            description: "A test service",
          },
        ],
        routes: [
          {
            path: "/api/test",
            method: "GET",
            name: "test-route",
            public: true,
          },
        ],
        events: {
          MESSAGE_RECEIVED: ["handleMessage"],
        },
      };

      // Type validation - if this compiles, types are correct
      expect(manifest.name).toBe("test-plugin");
      expect(manifest.language).toBe("rust");
      expect(manifest.interop?.protocol).toBe("wasm");
      expect(manifest.actions?.length).toBe(1);
      expect(manifest.providers?.length).toBe(1);
    });

    test("should allow minimal manifest", () => {
      const minimal: PluginManifest = {
        name: "minimal-plugin",
        description: "Minimal",
        version: "1.0.0",
        language: "typescript",
      };

      expect(minimal.name).toBe("minimal-plugin");
      expect(minimal.actions).toBeUndefined();
    });
  });

  describe("InteropProtocol", () => {
    test("should accept valid protocols", () => {
      const protocols: InteropProtocol[] = ["wasm", "ffi", "ipc", "native"];

      expect(protocols).toHaveLength(4);
      expect(protocols).toContain("wasm");
      expect(protocols).toContain("ffi");
      expect(protocols).toContain("ipc");
      expect(protocols).toContain("native");
    });
  });

  describe("PluginLanguage", () => {
    test("should accept valid languages", () => {
      const languages: PluginLanguage[] = ["typescript", "rust", "python"];

      expect(languages).toHaveLength(3);
      expect(languages).toContain("typescript");
      expect(languages).toContain("rust");
      expect(languages).toContain("python");
    });
  });

  describe("IPC Messages", () => {
    test("should create valid ActionInvokeRequest", () => {
      const memory: Memory = {
        id: "mem-1" as UUID,
        entityId: "entity-123" as UUID,
        roomId: "room-123" as UUID,
        content: { text: "Hello" },
      };
      const state: State = {
        text: "Current state",
        values: {},
        data: {},
      };
      const request: ActionInvokeRequest = {
        type: "action.invoke",
        id: "req-123",
        action: "TEST_ACTION",
        memory,
        state,
        options: { timeout: 5000 },
      };

      expect(request.type).toBe("action.invoke");
      expect(request.action).toBe("TEST_ACTION");
      expect(request.id).toBe("req-123");
    });

    test("should create valid ActionResultResponse", () => {
      const response: ActionResultResponse = {
        type: "action.result",
        id: "req-123",
        result: {
          success: true,
          text: "Action completed",
          data: { key: "value" },
          values: { count: 1 },
        },
      };

      expect(response.type).toBe("action.result");
      expect(response.result.success).toBe(true);
      expect(response.result.text).toBe("Action completed");
    });

    test("should create valid ProviderGetRequest", () => {
      const memory: Memory = {
        id: "mem-2" as UUID,
        entityId: "entity-456" as UUID,
        roomId: "room-456" as UUID,
        content: { text: "Query" },
      };
      const state: State = {
        text: "State",
        values: {},
        data: {},
      };
      const request: ProviderGetRequest = {
        type: "provider.get",
        id: "req-456",
        provider: "TEST_PROVIDER",
        memory,
        state,
      };

      expect(request.type).toBe("provider.get");
      expect(request.provider).toBe("TEST_PROVIDER");
    });

    test("should create valid ProviderResultResponse", () => {
      const response: ProviderResultResponse = {
        type: "provider.result",
        id: "req-456",
        result: {
          text: "Provider context",
          values: { key: "value" },
          data: { nested: { data: true } },
        },
      };

      expect(response.type).toBe("provider.result");
      expect(response.result.text).toBe("Provider context");
    });

    test("should serialize IPC messages to JSON", () => {
      const memory: Memory = {
        entityId: "entity-789" as UUID,
        roomId: "room-789" as UUID,
        content: { text: "test" },
      };
      const request: ActionInvokeRequest = {
        type: "action.invoke",
        id: "req-789",
        action: "SERIALIZE_TEST",
        memory,
        state: null,
        options: null,
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json) as ActionInvokeRequest;

      expect(parsed.type).toBe("action.invoke");
      expect(parsed.action).toBe("SERIALIZE_TEST");
      expect(parsed.id).toBe("req-789");
    });
  });

  describe("ActionManifest", () => {
    test("should validate action with examples", () => {
      const action: ActionManifest = {
        name: "EXAMPLE_ACTION",
        description: "An action with examples",
        similes: ["DO_THING", "PERFORM_ACTION"],
        examples: [
          [
            {
              name: "user",
              content: {
                text: "Do the thing",
              },
            },
            {
              name: "agent",
              content: {
                text: "Done!",
                actions: ["EXAMPLE_ACTION"],
              },
            },
          ],
        ],
      };

      expect(action.name).toBe("EXAMPLE_ACTION");
      expect(action.examples?.length).toBe(1);
      expect(action.examples?.[0]?.length).toBe(2);
    });
  });

  describe("ProviderManifest", () => {
    test("should validate provider with all options", () => {
      const provider: ProviderManifest = {
        name: "FULL_PROVIDER",
        description: "A provider with all options",
        dynamic: true,
        position: 5,
        private: true,
      };

      expect(provider.dynamic).toBe(true);
      expect(provider.position).toBe(5);
      expect(provider.private).toBe(true);
    });
  });
});
