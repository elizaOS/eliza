/**
 * Comprehensive tests for character-history snapshotting, bounding, diffing,
 * modification logging, parsing, and limit normalization through deterministic
 * runtime memory stubs.
 */

import { type Memory, MemoryType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildCharacterHistorySnapshot,
  createHistoryWalkContext,
  diffCharacterHistorySnapshots,
  isCharacterHistoryUnbounded,
  listCharacterHistory,
  parseCharacterHistoryEntry,
  readOwnDataValue,
  recordCharacterHistory,
  toBoundedCharacterValue,
} from "./character-history.ts";

function makeMemory(timestamp: number): Memory {
  return {
    id: `m-${timestamp}`,
    entityId: "agent-123",
    roomId: "agent-123",
    content: { text: `change ${timestamp}` },
    createdAt: timestamp,
    metadata: {
      type: MemoryType.CUSTOM,
      service: "character_history",
      action: "character_updated",
      timestamp,
      historySource: "manual",
      fieldsChanged: ["name"],
      changes: [{ field: "name", before: "a", after: `b-${timestamp}` }],
      before: { name: "a" },
      after: { name: `b-${timestamp}` },
    },
  };
}

const ALL = Array.from({ length: 150 }, (_, i) => makeMemory(1000 + i));

async function probe(limit: unknown) {
  const getMemories = vi.fn(async () => ALL);
  const runtime = {
    agentId: "agent-123",
    getMemories,
  } as never;
  const result =
    limit === undefined
      ? await listCharacterHistory(runtime as never)
      : await listCharacterHistory(runtime as never, limit as number);
  return { result, getMemories };
}

describe("character snapshotting and bounding", () => {
  it("normalizes basic character fields into a clean snapshot", () => {
    const raw = {
      name: "  Eliza Agent  ",
      username: "eliza",
      bio: ["Helpful assistant", "Code expert"],
      system: "You are Eliza.",
      adjectives: ["smart", "fast"],
      topics: ["ai", "crypto"],
      style: {
        all: ["concise"],
        chat: ["friendly"],
        post: ["engaging"],
      },
    };

    const snapshot = buildCharacterHistorySnapshot(raw);
    expect(snapshot.name).toBe("Eliza Agent");
    expect(snapshot.username).toBe("eliza");
    expect(snapshot.bio).toEqual(["Helpful assistant", "Code expert"]);
    expect(snapshot.system).toBe("You are Eliza.");
    expect(snapshot.adjectives).toEqual(["smart", "fast"]);
    expect(snapshot.topics).toEqual(["ai", "crypto"]);
    expect(snapshot.style).toEqual({
      all: ["concise"],
      chat: ["friendly"],
      post: ["engaging"],
    });
  });

  it("normalizes single-string bio into array and trims string fields", () => {
    const raw = {
      name: "Agent",
      bio: "Single bio string",
      system: "Prompt text",
    };
    const snapshot = buildCharacterHistorySnapshot(raw);
    expect(snapshot.name).toBe("Agent");
    expect(snapshot.bio).toEqual(["Single bio string"]);
    expect(snapshot.system).toBe("Prompt text");
  });

  it("reads own data values and throws on accessor descriptors", () => {
    const obj = { normal: 42 };
    expect(readOwnDataValue(obj, "normal")).toBe(42);
    expect(readOwnDataValue(obj, "missing")).toBeUndefined();
    expect(readOwnDataValue(null, "foo")).toBeUndefined();

    const withGetter = {};
    Object.defineProperty(withGetter, "accessor", {
      get() {
        return "val";
      },
      enumerable: true,
    });
    expect(() => readOwnDataValue(withGetter, "accessor")).toThrow();
  });

  it("identifies unbounded character history errors on cyclic or over-depth structures", () => {
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;

    let caught: unknown;
    try {
      toBoundedCharacterValue(cyclic, createHistoryWalkContext());
    } catch (err) {
      caught = err;
    }
    expect(isCharacterHistoryUnbounded(caught)).toBe(true);

    const ctx = createHistoryWalkContext();
    const bounded = toBoundedCharacterValue({ a: 1, b: "two" }, ctx);
    expect(bounded).toEqual({ a: 1, b: "two" });
  });
});

describe("diffCharacterHistorySnapshots and recordCharacterHistory", () => {
  it("diffs snapshots and produces accurate field change list", () => {
    const before = { name: "Old", system: "Prompt A" };
    const after = { name: "New", system: "Prompt A", bio: ["new bio"] };

    const changes = diffCharacterHistorySnapshots(before, after);
    expect(changes).toEqual([
      { field: "name", before: "Old", after: "New" },
      { field: "bio", after: ["new bio"] },
    ]);
  });

  it("returns null when before and after character snapshots are identical", async () => {
    const createMemory = vi.fn();
    const runtime = {
      agentId: "agent-123",
      createMemory,
    } as never;

    const char = { name: "Same", bio: ["bio text"] };
    const result = await recordCharacterHistory(runtime, {
      previousCharacter: char,
      nextCharacter: char,
      source: "manual",
    });

    expect(result).toBeNull();
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("records a revision and emits CUSTOM memory when fields change", async () => {
    const createMemory = vi.fn(async (m) => m);
    const runtime = {
      agentId: "agent-123",
      createMemory,
    } as never;

    const before = { name: "OldName", bio: ["bio 1"] };
    const after = { name: "NewName", bio: ["bio 1", "bio 2"] };

    const result = await recordCharacterHistory(runtime, {
      previousCharacter: before,
      nextCharacter: after,
      source: "manual",
      timestamp: 1_700_000_000_000,
    });

    expect(result).not.toBeNull();
    expect(result?.summary).toBe("Manual edit changed name, bio");
    expect(result?.fieldsChanged).toEqual(["name", "bio"]);
    expect(result?.changes).toEqual([
      { field: "name", before: "OldName", after: "NewName" },
      { field: "bio", before: ["bio 1"], after: ["bio 1", "bio 2"] },
    ]);
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "agent-123",
        metadata: expect.objectContaining({
          type: MemoryType.CUSTOM,
          service: "character_history",
          action: "character_updated",
          historySource: "manual",
        }),
      }),
      "character_modifications",
    );
  });
});

describe("parseCharacterHistoryEntry", () => {
  it("parses valid memory row into structured CharacterHistoryEntry", () => {
    const memory = makeMemory(5000);
    const parsed = parseCharacterHistoryEntry(memory);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestamp).toBe(5000);
    expect(parsed?.source).toBe("manual");
    expect(parsed?.fieldsChanged).toEqual(["name"]);
  });

  it("returns null for non-history memory records", () => {
    const invalidAction: Memory = {
      id: "m-1",
      entityId: "agent-1",
      roomId: "room-1",
      content: { text: "hello" },
      metadata: { action: "unknown_action" },
    };
    expect(parseCharacterHistoryEntry(invalidAction)).toBeNull();

    const noMetadata: Memory = {
      id: "m-2",
      entityId: "agent-1",
      roomId: "room-1",
      content: { text: "hello" },
    };
    expect(parseCharacterHistoryEntry(noMetadata)).toBeNull();
  });
});

describe("listCharacterHistory limit guard", () => {
  it("returns complete history when limit is undefined", async () => {
    const { result, getMemories } = await probe(undefined);
    expect(result).toHaveLength(150);
    expect(getMemories).toHaveBeenCalledWith({
      entityId: "agent-123",
      tableName: "character_modifications",
    });
  });

  it("rejects invalid and non-finite limits", async () => {
    for (const bad of [
      0,
      -5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      await expect(
        listCharacterHistory(
          { agentId: "agent-123", getMemories: vi.fn() } as never,
          bad,
        ),
      ).rejects.toThrow(
        "Character history limit must be a positive safe integer",
      );
    }
  });

  it("respects an explicitly requested limit", async () => {
    const { result: r5 } = await probe(5);
    expect(r5).toHaveLength(5);
    const { result: r150 } = await probe(150);
    expect(r150).toHaveLength(150);
  });

  it("omits poisoned rows and fills the requested limit with adjacent valid history", async () => {
    const poisoned = makeMemory(2000);
    const cyclic: Record<string, unknown> = { name: "poisoned" };
    cyclic.self = cyclic;
    poisoned.metadata.before = cyclic as never;
    const valid = [makeMemory(1999), makeMemory(1998), makeMemory(1997)];
    const getMemories = vi.fn(async () => [poisoned, ...valid]);
    const runtime = { agentId: "agent-123", getMemories } as never;

    const result = await listCharacterHistory(runtime, 2);

    expect(result.map((entry) => entry.id)).toEqual(["m-1999", "m-1998"]);
    expect(result).toHaveLength(2);
  });

  it("omits over-depth and over-node rows while filling the requested limit", async () => {
    const overDepth = makeMemory(2001);
    let nested: Record<string, unknown> = {};
    overDepth.metadata.before = nested as never;
    for (let depth = 0; depth <= 64; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    const overNode = makeMemory(2000);
    const sparse: unknown[] = [];
    sparse.length = 100_001;
    overNode.metadata.before = { messageExamples: sparse } as never;
    const valid = [makeMemory(1999), makeMemory(1998), makeMemory(1997)];
    const getMemories = vi.fn(async () => [overDepth, overNode, ...valid]);
    const runtime = { agentId: "agent-123", getMemories } as never;

    const result = await listCharacterHistory(runtime, 2);

    expect(result.map((entry) => entry.id)).toEqual(["m-1999", "m-1998"]);
    expect(result).toHaveLength(2);
  });
});
