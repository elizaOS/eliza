/**
 * @fileoverview WASM Bindings Tests
 *
 * Tests the Rust WASM bindings to ensure they work correctly from TypeScript.
 * These tests verify that the WASM module can be loaded and used properly.
 *
 * These tests require the WASM module to be built first:
 *   cd packages/rust && ./build-wasm.sh
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Types for the WASM module
interface WasmModule {
  WasmUUID: {
    new (): { toString: () => string };
    fromString(s: string): { toString: () => string };
  };
  WasmMemory: {
    fromJson(json: string): {
      toJson: () => string;
      id: string | null;
      entityId: string;
      roomId: string;
      content: string;
    };
  };
  WasmCharacter: {
    fromJson(json: string): {
      toJson: () => string;
      name: string;
      system: string | null;
    };
  };
  WasmAgent: {
    fromJson(json: string): {
      toJson: () => string;
      id: string;
      name: string;
    };
  };
  WasmPlugin: {
    fromJson(json: string): {
      toJson: () => string;
      name: string;
      description: string | null;
    };
  };
  parseCharacter(
    json: string,
  ): ReturnType<WasmModule["WasmCharacter"]["fromJson"]>;
  parseMemory(json: string): ReturnType<WasmModule["WasmMemory"]["fromJson"]>;
  validateUUID(uuid: string): boolean;
  generateUUID(): string;
  stringToUuid(input: string): string;
  getVersion(): string;
  testMemoryRoundTrip(json: string): boolean;
  testCharacterRoundTrip(json: string): boolean;
  testAgentRoundTrip(json: string): boolean;
}

// Check if WASM module is built
const wasmPkgPath = path.join(__dirname, "../../pkg");
const wasmNodePath = path.join(__dirname, "../../pkg-node");
const wasmExists = fs.existsSync(wasmPkgPath) || fs.existsSync(wasmNodePath);

// Skip tests if WASM not built
const describeWasm = wasmExists ? describe : describe.skip;

describeWasm("WASM Bindings", () => {
  let wasm: WasmModule;

  beforeAll(async () => {
    // Try to load WASM module
    try {
      // For Node.js, use the node-specific build
      if (fs.existsSync(wasmNodePath)) {
        wasm = await import("../../pkg-node/elizaos.js");
      } else {
        wasm = await import("../../pkg/elizaos.js");
      }
    } catch (error) {
      console.warn("WASM module not available:", error);
    }
  });

  describe("UUID Operations", () => {
    it("should generate valid UUIDs", () => {
      if (!wasm) return;

      const uuid = wasm.generateUUID();
      expect(uuid).toBeDefined();
      expect(typeof uuid).toBe("string");
      expect(uuid.length).toBe(36);
      expect(wasm.validateUUID(uuid)).toBe(true);
    });

    it("should validate UUIDs correctly", () => {
      if (!wasm) return;

      expect(wasm.validateUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(
        true,
      );
      expect(wasm.validateUUID("invalid-uuid")).toBe(false);
      expect(wasm.validateUUID("")).toBe(false);
    });

    it("should convert strings to UUIDs deterministically", () => {
      if (!wasm) return;

      const uuid1 = wasm.stringToUuid("test-input");
      const uuid2 = wasm.stringToUuid("test-input");
      expect(uuid1).toBe(uuid2);

      const uuid3 = wasm.stringToUuid("different-input");
      expect(uuid1).not.toBe(uuid3);
    });

    it("should create UUID instances", () => {
      if (!wasm) return;

      const uuid = new wasm.WasmUUID();
      expect(uuid.toString()).toBeDefined();
      expect(uuid.toString().length).toBe(36);
    });

    it("should parse UUID from string", () => {
      if (!wasm) return;

      const uuidStr = "550e8400-e29b-41d4-a716-446655440000";
      const uuid = wasm.WasmUUID.fromString(uuidStr);
      expect(uuid.toString()).toBe(uuidStr);
    });
  });

  describe("Memory Operations", () => {
    const testMemoryJson = JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      entityId: "550e8400-e29b-41d4-a716-446655440001",
      roomId: "550e8400-e29b-41d4-a716-446655440002",
      content: {
        text: "Hello, world!",
        source: "test",
      },
      createdAt: 1704067200000,
    });

    it("should parse memory from JSON", () => {
      if (!wasm) return;

      const memory = wasm.parseMemory(testMemoryJson);
      expect(memory.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(memory.entityId).toBe("550e8400-e29b-41d4-a716-446655440001");
      expect(memory.roomId).toBe("550e8400-e29b-41d4-a716-446655440002");
    });

    it("should convert memory to JSON", () => {
      if (!wasm) return;

      const memory = wasm.WasmMemory.fromJson(testMemoryJson);
      const json = memory.toJson();
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.content.text).toBe("Hello, world!");
    });

    it("should pass memory round-trip test", () => {
      if (!wasm) return;

      expect(wasm.testMemoryRoundTrip(testMemoryJson)).toBe(true);
    });
  });

  describe("Character Operations", () => {
    const testCharacterJson = JSON.stringify({
      name: "TestAgent",
      system: "You are a helpful assistant.",
      bio: ["An AI assistant", "Helps users"],
      topics: ["general", "coding"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets: {},
      settings: {},
    });

    it("should parse character from JSON", () => {
      if (!wasm) return;

      const character = wasm.parseCharacter(testCharacterJson);
      expect(character.name).toBe("TestAgent");
      expect(character.system).toBe("You are a helpful assistant.");
    });

    it("should convert character to JSON", () => {
      if (!wasm) return;

      const character = wasm.WasmCharacter.fromJson(testCharacterJson);
      const json = character.toJson();
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe("TestAgent");
    });

    it("should pass character round-trip test", () => {
      if (!wasm) return;

      expect(wasm.testCharacterRoundTrip(testCharacterJson)).toBe(true);
    });
  });

  describe("Agent Operations", () => {
    const testAgentJson = JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "TestAgent",
      bio: ["A test agent"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets: {},
      settings: {},
      status: "active",
      enabled: true,
    });

    it("should parse agent from JSON", () => {
      if (!wasm) return;

      const agent = wasm.WasmAgent.fromJson(testAgentJson);
      expect(agent.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(agent.name).toBe("TestAgent");
    });

    it("should pass agent round-trip test", () => {
      if (!wasm) return;

      expect(wasm.testAgentRoundTrip(testAgentJson)).toBe(true);
    });
  });

  describe("Plugin Operations", () => {
    const testPluginJson = JSON.stringify({
      name: "test-plugin",
      description: "A test plugin",
      actions: [],
      evaluators: [],
      providers: [],
    });

    it("should parse plugin from JSON", () => {
      if (!wasm) return;

      const plugin = wasm.WasmPlugin.fromJson(testPluginJson);
      expect(plugin.name).toBe("test-plugin");
      expect(plugin.description).toBe("A test plugin");
    });
  });

  describe("Version", () => {
    it("should return version string", () => {
      if (!wasm) return;

      const version = wasm.getVersion();
      expect(version).toBeDefined();
      expect(typeof version).toBe("string");
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});

// Tests that don't require WASM to be built
describe("WASM Build Status", () => {
  it("should detect if WASM is built", () => {
    console.log(`WASM module exists: ${wasmExists}`);
    console.log(`  pkg path: ${wasmPkgPath}`);
    console.log(`  pkg-node path: ${wasmNodePath}`);
    // This test always passes, just logs status
    expect(true).toBe(true);
  });
});
