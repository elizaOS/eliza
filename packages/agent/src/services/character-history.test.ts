/**
 * Exercises character-history limit normalization through a deterministic
 * runtime memory stub, including defaults, non-finite values, and range caps.
 */

import { MemoryType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { listCharacterHistory } from "./character-history.ts";

function makeMemory(timestamp: number) {
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
      before: { name: "a" } as Record<string, unknown>,
      after: { name: `b-${timestamp}` } as Record<string, unknown>,
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
