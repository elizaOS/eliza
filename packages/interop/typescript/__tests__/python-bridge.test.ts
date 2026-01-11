/**
 * Tests for Python Plugin Bridge
 */

import type { Memory, State, UUID } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import type {
  ActionInvokeRequest,
  ActionResultResponse,
  IPCRequest,
  PluginManifest,
  ProviderGetRequest,
  ProviderResultResponse,
  ValidationResponse,
} from "../types";

describe("Python Bridge", () => {
  describe("IPC Protocol", () => {
    test("should format action.invoke request correctly", () => {
      const memory: Memory = {
        id: "123" as UUID,
        entityId: "entity-123" as UUID,
        roomId: "room-123" as UUID,
        content: { text: "Hello" },
      };
      const state: State = {
        values: { key: "value" },
        data: {},
        text: "",
      };
      const request: ActionInvokeRequest = {
        type: "action.invoke",
        id: "req-001",
        action: "HELLO_PYTHON",
        memory,
        state,
        options: { timeout: 5000 },
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe("action.invoke");
      expect(parsed.action).toBe("HELLO_PYTHON");
      expect(parsed.memory.content.text).toBe("Hello");
    });

    test("should format action.validate request correctly", () => {
      const memory: Memory = {
        entityId: "entity-123" as UUID,
        roomId: "room-123" as UUID,
        content: { text: "Test" },
      };
      const request: IPCRequest = {
        type: "action.validate",
        id: "req-002",
        action: "VALIDATE_ACTION",
        memory,
        state: null,
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe("action.validate");
      expect(parsed.action).toBe("VALIDATE_ACTION");
    });

    test("should format provider.get request correctly", () => {
      const memory: Memory = {
        entityId: "entity-123" as UUID,
        roomId: "room-123" as UUID,
        content: {},
      };
      const state: State = {
        values: {},
        data: {},
        text: "",
      };
      const request: ProviderGetRequest = {
        type: "provider.get",
        id: "req-003",
        provider: "PYTHON_INFO",
        memory,
        state,
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe("provider.get");
      expect(parsed.provider).toBe("PYTHON_INFO");
    });

    test("should format plugin.init request correctly", () => {
      const request: IPCRequest = {
        type: "plugin.init",
        id: "req-004",
        config: {
          API_KEY: "test-key",
          DEBUG: "true",
        },
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe("plugin.init");
      expect(parsed.config.API_KEY).toBe("test-key");
    });
  });

  describe("IPC Response Parsing", () => {
    test("should parse action.result response", () => {
      const responseJson = JSON.stringify({
        type: "action.result",
        id: "req-001",
        result: {
          success: true,
          text: "Hello from Python! 🐍",
          data: { language: "python" },
        },
      });

      const response: ActionResultResponse = JSON.parse(responseJson);

      expect(response.type).toBe("action.result");
      expect(response.result.success).toBe(true);
      expect(response.result.text).toBe("Hello from Python! 🐍");
    });

    test("should parse validate.result response", () => {
      const responseJson = JSON.stringify({
        type: "validate.result",
        id: "req-002",
        valid: true,
      });

      const response: ValidationResponse = JSON.parse(responseJson);

      expect(response.type).toBe("validate.result");
      expect(response.valid).toBe(true);
    });

    test("should parse provider.result response", () => {
      const responseJson = JSON.stringify({
        type: "provider.result",
        id: "req-003",
        result: {
          text: "Python environment info",
          values: { version: "3.11" },
          data: { platform: "linux" },
        },
      });

      const response: ProviderResultResponse = JSON.parse(responseJson);

      expect(response.type).toBe("provider.result");
      expect(response.result.text).toBe("Python environment info");
      expect(response.result.values?.version).toBe("3.11");
    });

    test("should parse error response", () => {
      const responseJson = JSON.stringify({
        type: "error",
        id: "req-005",
        error: "Module not found",
        details: "Traceback...",
      });

      const response = JSON.parse(responseJson);

      expect(response.type).toBe("error");
      expect(response.error).toBe("Module not found");
    });

    test("should parse ready message with manifest", () => {
      const manifest: PluginManifest = {
        name: "python-plugin",
        description: "A Python plugin",
        version: "1.0.0",
        language: "python",
        actions: [{ name: "PY_ACTION", description: "Python action" }],
      };

      const readyMessage = JSON.stringify({
        type: "ready",
        manifest,
      });

      const parsed = JSON.parse(readyMessage);

      expect(parsed.type).toBe("ready");
      expect(parsed.manifest.name).toBe("python-plugin");
      expect(parsed.manifest.actions[0].name).toBe("PY_ACTION");
    });
  });

  describe("Message Buffer Handling", () => {
    test("should handle newline-delimited messages", () => {
      const messages = [
        {
          type: "ready",
          manifest: {
            name: "test",
            description: "Test",
            version: "1.0.0",
            language: "python",
          },
        },
        { type: "action.result", id: "1", result: { success: true } },
        { type: "provider.result", id: "2", result: { text: "data" } },
      ];

      const buffer = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
      const lines = buffer.split("\n").filter((l) => l.trim());

      expect(lines).toHaveLength(3);
      lines.forEach((line, i) => {
        const parsed = JSON.parse(line);
        expect(parsed.type).toBe(messages[i].type);
      });
    });

    test("should handle partial messages in buffer", () => {
      const fullMessage = JSON.stringify({ type: "test", data: "complete" });
      const partial1 = fullMessage.slice(0, 10);
      const partial2 = fullMessage.slice(10);

      // Simulate buffering
      let buffer = partial1;
      expect(() => JSON.parse(buffer)).toThrow();

      buffer += partial2;
      const parsed = JSON.parse(buffer);
      expect(parsed.type).toBe("test");
    });
  });

  describe("Plugin Adapter Creation", () => {
    test("should create action handlers from manifest", () => {
      const manifest: PluginManifest = {
        name: "adapter-python",
        description: "Test Python adapter",
        version: "1.0.0",
        language: "python",
        actions: [
          {
            name: "PY_ACTION_1",
            description: "First Python action",
            similes: ["PYTHON_1"],
          },
          {
            name: "PY_ACTION_2",
            description: "Second Python action",
          },
        ],
      };

      // Simulate adapter creation
      const actions = manifest.actions
        ? manifest.actions.map((actionDef) => ({
            name: actionDef.name,
            description: actionDef.description,
            similes: actionDef.similes,
            examples: actionDef.examples,
            validate: async () => {
              // Would send IPC request
              return true;
            },
            handler: async () => {
              // Would send IPC request
              return { success: true, text: "Result from Python" };
            },
          }))
        : [];

      expect(actions).toHaveLength(2);
      expect(actions[0].name).toBe("PY_ACTION_1");
      expect(actions[1].name).toBe("PY_ACTION_2");
    });

    test("should create provider handlers from manifest", () => {
      const manifest: PluginManifest = {
        name: "provider-python",
        description: "Test Python providers",
        version: "1.0.0",
        language: "python",
        providers: [
          {
            name: "PYTHON_INFO",
            description: "Python environment info",
            dynamic: true,
          },
        ],
      };

      const providers = manifest.providers
        ? manifest.providers.map((providerDef) => ({
            name: providerDef.name,
            description: providerDef.description,
            dynamic: providerDef.dynamic,
            position: providerDef.position,
            private: providerDef.private,
            get: async () => {
              // Would send IPC request
              return { text: "Provider data" };
            },
          }))
        : [];

      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("PYTHON_INFO");
      expect(providers[0].dynamic).toBe(true);
    });
  });

  describe("Request ID Generation", () => {
    test("should generate unique request IDs", () => {
      let counter = 0;
      const generateId = () => `req_${++counter}`;

      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }

      expect(ids.size).toBe(100);
    });
  });

  describe("Timeout Handling", () => {
    test("should track pending requests", async () => {
      const pending = new Map<
        string,
        {
          resolve: (value: unknown) => void;
          reject: (reason?: unknown) => void;
        }
      >();

      // Simulate request
      const requestId = "test-request";
      const promise = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
      });

      expect(pending.has(requestId)).toBe(true);

      // Simulate response
      const pendingReq = pending.get(requestId);
      pending.delete(requestId);
      if (pendingReq) {
        pendingReq.resolve({ success: true });
      }

      expect(pending.has(requestId)).toBe(false);

      const result = await promise;
      expect(result).toEqual({ success: true });
    });
  });

  describe("Error Handling", () => {
    test("should handle malformed JSON", () => {
      const invalidJson = '{ type: "error", }';

      expect(() => JSON.parse(invalidJson)).toThrow();
    });

    test("should handle missing required fields", () => {
      const incompleteResponse: Partial<ActionResultResponse> = {
        type: "action.result",
      };
      // Missing id and result - should be validated at runtime

      expect(incompleteResponse.type).toBe("action.result");
      expect(incompleteResponse.result).toBeUndefined();
    });

    test("should format error responses correctly", () => {
      const errorResponse = {
        type: "error",
        id: "req-error",
        error: "Action failed",
        details: {
          traceback: "Line 1\nLine 2\n",
          exception_type: "ValueError",
        },
      };

      const json = JSON.stringify(errorResponse);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe("error");
      expect(parsed.error).toBe("Action failed");
      expect(parsed.details.exception_type).toBe("ValueError");
    });
  });

  describe("Complex Data Types", () => {
    test("should handle nested objects in memory", () => {
      const memory: Memory = {
        id: "mem-complex" as UUID,
        entityId: "entity-123" as UUID,
        roomId: "room-123" as UUID,
        content: {
          text: "Complex message",
          data: {
            nested: {
              deeply: {
                value: "found",
              },
            },
            array: [1, 2, 3, { key: "value" }],
          },
        },
      };

      const request: ActionInvokeRequest = {
        type: "action.invoke",
        id: "complex-req",
        action: "PROCESS",
        memory,
        state: null,
        options: null,
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.memory.content.data.nested.deeply.value).toBe("found");
      expect(parsed.memory.content.data.array[3].key).toBe("value");
    });

    test("should handle Unicode in messages", () => {
      const request = {
        type: "action.invoke",
        id: "unicode-req",
        action: "GREET",
        memory: {
          content: {
            text: "Hello 世界! 🌍 مرحبا שָׁלוֹם",
          },
        },
        state: null,
        options: null,
      };

      const json = JSON.stringify(request);
      const parsed = JSON.parse(json);

      expect(parsed.memory.content.text).toBe("Hello 世界! 🌍 مرحبا שָׁלוֹם");
    });

    test("should handle large payloads", () => {
      const largeData = "x".repeat(100000);

      const request = {
        type: "action.invoke",
        action: "PROCESS_LARGE",
        memory: { content: { text: largeData } },
      };

      const json = JSON.stringify(request);
      expect(json.length).toBeGreaterThan(100000);

      const parsed = JSON.parse(json);
      expect(parsed.memory.content.text.length).toBe(100000);
    });
  });
});
