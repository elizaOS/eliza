import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAction } from "../src/actions/forget";
import { recallAction } from "../src/actions/recall";
import { rememberAction } from "../src/actions/remember";
import { memoryContextProvider } from "../src/providers/memoryContext";
import {
  decodeMemoryText,
  encodeMemoryText,
  MEMORY_METADATA_SEPARATOR,
  MEMORY_SOURCE,
  MemoryImportance,
} from "../src/types";

// --- Type Encoding / Decoding ---

describe("Memory Text Encoding", () => {
  it("should encode and decode memory text round-trip", () => {
    const content = "My favorite color is blue";
    const tags = ["preference", "color"];
    const importance = MemoryImportance.HIGH;

    const encoded = encodeMemoryText(content, tags, importance);
    const decoded = decodeMemoryText(encoded);

    expect(decoded.content).toBe(content);
    expect(decoded.tags).toEqual(tags);
    expect(decoded.importance).toBe(importance);
  });

  it("should handle decoding text without metadata", () => {
    const plainText = "Just some text without metadata";
    const decoded = decodeMemoryText(plainText);

    expect(decoded.content).toBe(plainText);
    expect(decoded.tags).toEqual([]);
    expect(decoded.importance).toBe(MemoryImportance.NORMAL);
  });

  it("should handle decoding text with malformed metadata", () => {
    const badText = `not-valid-json${MEMORY_METADATA_SEPARATOR}actual content`;
    const decoded = decodeMemoryText(badText);

    // Falls back to treating entire string as content
    expect(decoded.content).toBe(badText);
    expect(decoded.tags).toEqual([]);
    expect(decoded.importance).toBe(MemoryImportance.NORMAL);
  });

  it("should encode empty tags correctly", () => {
    const encoded = encodeMemoryText("test", [], MemoryImportance.LOW);
    const decoded = decodeMemoryText(encoded);

    expect(decoded.content).toBe("test");
    expect(decoded.tags).toEqual([]);
    expect(decoded.importance).toBe(MemoryImportance.LOW);
  });

  it("should preserve all importance levels", () => {
    for (const importance of [
      MemoryImportance.LOW,
      MemoryImportance.NORMAL,
      MemoryImportance.HIGH,
      MemoryImportance.CRITICAL,
    ]) {
      const encoded = encodeMemoryText("test", [], importance);
      const decoded = decodeMemoryText(encoded);
      expect(decoded.importance).toBe(importance);
    }
  });

  it("should handle special characters in content", () => {
    const content = 'Content with "quotes" and\nnewlines and {braces}';
    const encoded = encodeMemoryText(content, ["special"], MemoryImportance.NORMAL);
    const decoded = decodeMemoryText(encoded);
    expect(decoded.content).toBe(content);
  });
});

// --- Action Metadata Validation ---

describe("REMEMBER Action", () => {
  it("should have correct action metadata", () => {
    expect(rememberAction.name).toBe("REMEMBER");
    expect(rememberAction.description).toBeTruthy();
    expect(rememberAction.similes).toContain("remember");
    expect(rememberAction.examples.length).toBeGreaterThan(0);
  });

  it("should validate when runtime has createMemory", async () => {
    const runtime = {
      createMemory: vi.fn(),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "test" },
    } as Memory;

    const result = await rememberAction.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("should fail validation when createMemory is unavailable", async () => {
    const runtime = {} as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "test" },
    } as Memory;

    const result = await rememberAction.validate(runtime, message);
    expect(result).toBe(false);
  });

  it("should store memory via runtime.createMemory", async () => {
    const mockCreateMemory = vi.fn().mockResolvedValue("mem-uuid");

    const runtime = {
      createMemory: mockCreateMemory,
      agentId: "agent-1",
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          memory: "User prefers dark mode",
          tags: ["preference", "ui"],
          importance: 2,
        })
      ),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      userId: "user-1",
      content: { text: "I prefer dark mode" },
    } as Memory;

    const result = await rememberAction.handler(runtime, message);

    expect(result.success).toBe(true);
    expect(mockCreateMemory).toHaveBeenCalledOnce();
    expect(result.text).toContain("Remembered");
  });
});

// --- RECALL Action ---

describe("RECALL Action", () => {
  it("should have correct action metadata", () => {
    expect(recallAction.name).toBe("RECALL");
    expect(recallAction.description).toBeTruthy();
    expect(recallAction.similes).toContain("recall");
    expect(recallAction.examples.length).toBeGreaterThan(0);
  });

  it("should return empty results when no memories exist", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "What do you remember?" },
    } as Memory;

    const result = await recallAction.handler(runtime, message);
    expect(result.success).toBe(true);
    expect(result.text).toContain("don't have any stored memories");
  });

  it("should find memories matching query", async () => {
    const encoded = encodeMemoryText(
      "Favorite color is blue",
      ["preference"],
      MemoryImportance.NORMAL
    );
    const storedMemories: Partial<Memory>[] = [
      {
        id: "mem-1",
        agentId: "agent-1",
        roomId: "room-1",
        content: { text: encoded, source: MEMORY_SOURCE },
        createdAt: Date.now(),
      },
    ];

    const runtime = {
      getMemories: vi.fn().mockResolvedValue(storedMemories),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "color" },
    } as Memory;

    const result = await recallAction.handler(runtime, message);
    expect(result.success).toBe(true);
    expect(result.text).toContain("Found 1 memory");
    expect(result.text).toContain("Favorite color is blue");
  });

  it("should filter by tags when specified", async () => {
    const mem1 = encodeMemoryText("Color is blue", ["color"], MemoryImportance.NORMAL);
    const mem2 = encodeMemoryText("Deadline is Friday", ["project"], MemoryImportance.NORMAL);
    const storedMemories: Partial<Memory>[] = [
      {
        id: "m1",
        agentId: "a1",
        roomId: "r1",
        content: { text: mem1, source: MEMORY_SOURCE },
        createdAt: Date.now(),
      },
      {
        id: "m2",
        agentId: "a1",
        roomId: "r1",
        content: { text: mem2, source: MEMORY_SOURCE },
        createdAt: Date.now(),
      },
    ];

    const runtime = {
      getMemories: vi.fn().mockResolvedValue(storedMemories),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "a1",
      roomId: "r1",
      content: { text: "search" },
    } as Memory;

    const options = { parameters: { query: "search", tags: ["color"] } };
    const result = await recallAction.handler(runtime, message, undefined, options);
    expect(result.success).toBe(true);
  });
});

// --- FORGET Action ---

describe("FORGET Action", () => {
  it("should have correct action metadata", () => {
    expect(forgetAction.name).toBe("FORGET");
    expect(forgetAction.description).toBeTruthy();
    expect(forgetAction.similes).toContain("forget");
    expect(forgetAction.examples.length).toBeGreaterThan(0);
  });

  it("should remove memory by ID when provided", async () => {
    const mockDeleteMemory = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      deleteMemory: mockDeleteMemory,
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "forget this" },
    } as Memory;

    const options = { parameters: { memoryId: "mem-123" } };
    const result = await forgetAction.handler(runtime, message, undefined, options);
    expect(result.success).toBe(true);
    expect(mockDeleteMemory).toHaveBeenCalledWith("mem-123");
  });

  it("should report when no memories exist to remove", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
      deleteMemory: vi.fn(),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "forget about colors" },
    } as Memory;

    const result = await forgetAction.handler(runtime, message);
    expect(result.success).toBe(true);
    expect(result.text).toContain("No stored memories found");
  });
});

// --- Memory Context Provider ---

describe("Memory Context Provider", () => {
  it("should have correct provider metadata", () => {
    expect(memoryContextProvider.name).toBe("MEMORY_CONTEXT");
    expect(memoryContextProvider.description).toBeTruthy();
  });

  it("should return no memories message when store is empty", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      content: { text: "" },
    } as Memory;

    const result = await memoryContextProvider.get(runtime, message, {} as never);
    expect(result.text).toContain("No stored memories");
  });

  it("should return formatted memory list sorted by importance", async () => {
    const lowMem = encodeMemoryText("Low importance", ["test"], MemoryImportance.LOW);
    const highMem = encodeMemoryText("High importance", ["test"], MemoryImportance.HIGH);

    const storedMemories: Partial<Memory>[] = [
      {
        id: "m-low",
        agentId: "a1",
        roomId: "r1",
        content: { text: lowMem, source: MEMORY_SOURCE },
        createdAt: 1000,
      },
      {
        id: "m-high",
        agentId: "a1",
        roomId: "r1",
        content: { text: highMem, source: MEMORY_SOURCE },
        createdAt: 2000,
      },
    ];

    const runtime = {
      getMemories: vi.fn().mockResolvedValue(storedMemories),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "a1",
      roomId: "r1",
      content: { text: "" },
    } as Memory;

    const result = await memoryContextProvider.get(runtime, message, {} as never);
    expect(result.text).toContain("Stored Memories (2)");
    // High importance should appear before low importance
    const highIdx = result.text.indexOf("High importance");
    const lowIdx = result.text.indexOf("Low importance");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});
