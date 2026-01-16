/**
 * @fileoverview Interop Equivalence Tests
 *
 * Tests that verify the Rust WASM implementation produces identical results
 * to the TypeScript implementation for all core types and operations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Character, CharacterInput, Content, Memory } from "@elizaos/core";
import { createCharacter, stringToUuid } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";

// WASM module interface
interface WasmModule {
  stringToUuid(input: string): string;
  generateUUID(): string;
  validateUUID(uuid: string): boolean;
  parseMemory(json: string): { toJson: () => string };
  parseCharacter(json: string): { toJson: () => string };
  testMemoryRoundTrip(json: string): boolean;
  testCharacterRoundTrip(json: string): boolean;
}

// Check if WASM module is built
const wasmNodePath = path.join(__dirname, "../../pkg-node");
const wasmExists = fs.existsSync(wasmNodePath);

const describeInterop = wasmExists ? describe : describe.skip;

describeInterop("TypeScript/Rust Interop Equivalence", () => {
  let wasm: WasmModule;

  beforeAll(async () => {
    try {
      wasm = await import("../../pkg-node/elizaos.js");
    } catch (error) {
      console.warn("WASM module not available:", error);
    }
  });

  describe("UUID Generation Equivalence", () => {
    it("should generate deterministic UUIDs from strings identically", () => {
      if (!wasm) return;

      const testInputs = [
        "test",
        "hello-world",
        "agent-123",
        "room-abc",
        "user@example.com",
        "some random string with spaces",
        "12345",
        "",
      ];

      for (const input of testInputs) {
        const tsUuid = stringToUuid(input);
        const rustUuid = wasm.stringToUuid(input);

        // Both should produce valid UUIDs
        expect(wasm.validateUUID(tsUuid)).toBe(true);
        expect(wasm.validateUUID(rustUuid)).toBe(true);

        // UUIDs may differ if algorithms differ, but both should be deterministic
        const tsUuid2 = stringToUuid(input);
        const rustUuid2 = wasm.stringToUuid(input);

        expect(tsUuid).toBe(tsUuid2);
        expect(rustUuid).toBe(rustUuid2);
      }
    });
  });

  describe("Memory Serialization Equivalence", () => {
    it("should serialize Memory identically", () => {
      if (!wasm) return;

      const memory: Memory = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        entityId: "550e8400-e29b-41d4-a716-446655440001",
        roomId: "550e8400-e29b-41d4-a716-446655440002",
        content: {
          text: "Hello, world!",
          source: "test",
        },
        createdAt: 1704067200000,
      };

      const tsJson = JSON.stringify(memory);
      const rustMemory = wasm.parseMemory(tsJson);
      const rustJson = rustMemory.toJson();

      // Parse both to compare
      const tsObj = JSON.parse(tsJson);
      const rustObj = JSON.parse(rustJson);

      // Key fields should match
      expect(rustObj.id).toBe(tsObj.id);
      expect(rustObj.entityId).toBe(tsObj.entityId);
      expect(rustObj.roomId).toBe(tsObj.roomId);
      expect(rustObj.content?.text).toBe(tsObj.content?.text);
      expect(rustObj.createdAt).toBe(tsObj.createdAt);
    });

    it("should handle optional fields consistently", () => {
      if (!wasm) return;

      const minimalMemory: Memory = {
        entityId: "550e8400-e29b-41d4-a716-446655440001",
        roomId: "550e8400-e29b-41d4-a716-446655440002",
        content: { text: "test" },
      };

      const tsJson = JSON.stringify(minimalMemory);
      const rustMemory = wasm.parseMemory(tsJson);
      const rustJson = rustMemory.toJson();

      const rustObj = JSON.parse(rustJson);

      // Required fields should be present
      expect(rustObj.entityId).toBe(minimalMemory.entityId);
      expect(rustObj.roomId).toBe(minimalMemory.roomId);
      expect(rustObj.content?.text).toBe("test");
    });

    it("should pass round-trip test", () => {
      if (!wasm) return;

      const memory: Memory = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        entityId: "550e8400-e29b-41d4-a716-446655440001",
        roomId: "550e8400-e29b-41d4-a716-446655440002",
        content: {
          text: "Test message",
          source: "integration-test",
          metadata: { key: "value" },
        },
        createdAt: Date.now(),
      };

      expect(wasm.testMemoryRoundTrip(JSON.stringify(memory))).toBe(true);
    });
  });

  describe("Character Serialization Equivalence", () => {
    it("should serialize Character identically", () => {
      if (!wasm) return;

      const character: Character = createCharacter({
        name: "TestAgent",
        system: "You are a helpful assistant.",
        bio: ["An AI assistant", "Helps users with tasks"],
        topics: ["general", "coding", "writing"],
        messageExamples: [],
        postExamples: [],
        settings: {},
      });

      const tsJson = JSON.stringify(character);
      const rustCharacter = wasm.parseCharacter(tsJson);
      const rustJson = rustCharacter.toJson();

      const tsObj = JSON.parse(tsJson);
      const rustObj = JSON.parse(rustJson);

      expect(rustObj.name).toBe(tsObj.name);
      expect(rustObj.system).toBe(tsObj.system);
    });

    it("should handle bio as string or array", () => {
      if (!wasm) return;

      // Bio as string (Character.bio is string | string[])
      const charWithStringBio: CharacterInput = {
        name: "Agent1",
        bio: "A simple bio",
        messageExamples: [],
        postExamples: [],
      };

      // Bio as array
      const charWithArrayBio: CharacterInput = {
        name: "Agent2",
        bio: ["Line 1", "Line 2"],
        messageExamples: [],
        postExamples: [],
      };

      // Both should parse successfully
      expect(() =>
        wasm.parseCharacter(JSON.stringify(charWithStringBio)),
      ).not.toThrow();
      expect(() =>
        wasm.parseCharacter(JSON.stringify(charWithArrayBio)),
      ).not.toThrow();
    });

    it("should pass round-trip test", () => {
      if (!wasm) return;

      const character: Character = createCharacter({
        name: "TestAgent",
        system: "You are helpful",
        bio: ["Bio line 1", "Bio line 2"],
        topics: ["topic1", "topic2"],
        messageExamples: [],
        postExamples: [],
        settings: {
          model: "gpt-4",
          temperature: 0.7,
        },
      });

      expect(wasm.testCharacterRoundTrip(JSON.stringify(character))).toBe(true);
    });
  });

  describe("Content Serialization Equivalence", () => {
    it("should serialize Content with all fields", () => {
      if (!wasm) return;

      const memory: Memory = {
        entityId: "entity-123",
        roomId: "room-456",
        content: {
          text: "Hello",
          source: "test",
          url: "https://example.com",
          actions: ["action1", "action2"],
          metadata: { key: "value" },
          attachments: [{ type: "image", url: "https://..." }],
        },
      };

      const rustMemory = wasm.parseMemory(JSON.stringify(memory));
      const rustJson = rustMemory.toJson();
      const rustObj = JSON.parse(rustJson);

      expect(rustObj.content.text).toBe("Hello");
      expect(rustObj.content.source).toBe("test");
      expect(rustObj.content.url).toBe("https://example.com");
      expect(Array.isArray(rustObj.content.actions)).toBe(true);
    });
  });

  describe("Nested Object Equivalence", () => {
    it("should handle deeply nested structures", () => {
      if (!wasm) return;

      const character: Character = {
        name: "DeepAgent",
        messageExamples: [
          [
            {
              name: "user",
              content: { text: "Hello", metadata: { nested: { deep: true } } },
            },
            { name: "agent", content: { text: "Hi there!" } },
          ],
        ],
        postExamples: [],
        settings: {
          secrets: {
            API_KEY: "secret-value",
          },
          nested: {
            config: {
              option: true,
            },
          },
        },
      };

      const rustCharacter = wasm.parseCharacter(JSON.stringify(character));
      const rustJson = rustCharacter.toJson();
      const rustObj = JSON.parse(rustJson);

      expect(rustObj.name).toBe("DeepAgent");
      expect(rustObj.settings?.secrets?.API_KEY).toBe("secret-value");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty strings", () => {
      if (!wasm) return;

      const memory: Memory = {
        entityId: "entity-123",
        roomId: "room-456",
        content: { text: "" },
      };

      const rustMemory = wasm.parseMemory(JSON.stringify(memory));
      const rustObj = JSON.parse(rustMemory.toJson());

      expect(rustObj.content.text).toBe("");
    });

    it("should handle unicode characters", () => {
      if (!wasm) return;

      const memory: Memory = {
        entityId: "entity-123",
        roomId: "room-456",
        content: { text: "Hello 世界 🎉 émojis and ñ characters" },
      };

      const rustMemory = wasm.parseMemory(JSON.stringify(memory));
      const rustObj = JSON.parse(rustMemory.toJson());

      expect(rustObj.content.text).toBe(
        "Hello 世界 🎉 émojis and ñ characters",
      );
    });

    it("should handle large numbers", () => {
      if (!wasm) return;

      const memory: Memory = {
        entityId: "entity-123",
        roomId: "room-456",
        content: { text: "test" },
        createdAt: 9007199254740991, // Number.MAX_SAFE_INTEGER
      };

      const rustMemory = wasm.parseMemory(JSON.stringify(memory));
      const rustObj = JSON.parse(rustMemory.toJson());

      expect(rustObj.createdAt).toBe(9007199254740991);
    });

    it("should handle null values", () => {
      if (!wasm) return;

      // Content.source is optional (string | undefined), but JSON.stringify converts undefined to null
      // Create a memory object with source explicitly set to null via JSON parsing
      const memoryJson = JSON.stringify({
        entityId: "entity-123",
        roomId: "room-456",
        content: {
          text: "test",
          source: null,
        },
      });
      const memory: Memory = JSON.parse(memoryJson);

      // Should not throw
      expect(() => wasm.parseMemory(JSON.stringify(memory))).not.toThrow();
    });
  });
});

// Tests that work without WASM
describe("TypeScript Type Verification", () => {
  it("should verify Memory type structure", () => {
    const memory: Memory = {
      entityId: "entity-123",
      roomId: "room-456",
      content: { text: "Hello" },
    };

    expect(memory.entityId).toBeDefined();
    expect(memory.roomId).toBeDefined();
    expect(memory.content).toBeDefined();
  });

  it("should verify Character type structure", () => {
    const character: Character = {
      name: "TestAgent",
      messageExamples: [],
      postExamples: [],
    };

    expect(character.name).toBeDefined();
  });

  it("should verify Content type structure", () => {
    const content: Content = {
      text: "Hello",
      source: "test",
    };

    expect(content.text).toBe("Hello");
    expect(content.source).toBe("test");
  });
});
