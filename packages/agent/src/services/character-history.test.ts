/**
 * Exercises character-history limit normalization through a deterministic
 * runtime memory stub, including defaults, non-finite values, and range caps.
 */

import { MemoryType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listCharacterHistory,
  MAX_CHARACTER_HISTORY_LIMIT,
} from "./character-history.ts";

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

describe("listCharacterHistory limit guard", () => {
  it("defaults to 20 when limit is undefined (no arg)", async () => {
    const { result, getMemories } = await probe(undefined);
    expect(result).toHaveLength(20);
    expect(getMemories).toHaveBeenCalledWith(
      expect.objectContaining({ count: 80 }),
    );
  });

  it("falls back to 20 for NaN and non-finite (Infinity/-Infinity)", async () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const { result, getMemories } = await probe(bad);
      expect(result, `limit=${String(bad)}`).toHaveLength(20);
      expect(getMemories).toHaveBeenCalledWith(
        expect.objectContaining({ count: 80 }),
      );
    }
  });

  it("maps zero and negative values to the minimum of 1", async () => {
    for (const v of [0, -5, -1]) {
      const { result, getMemories } = await probe(v);
      expect(result, `limit=${v}`).toHaveLength(1);
      expect(getMemories).toHaveBeenCalledWith(
        expect.objectContaining({ count: 4 }),
      );
    }
  });

  it("respects valid mid-range limits and truncates decimals", async () => {
    const { result: r5 } = await probe(5);
    expect(r5).toHaveLength(5);
    const { result: rTrunc } = await probe(5.9);
    expect(rTrunc).toHaveLength(5);
    const { result: r7 } = await probe(7.1);
    expect(r7).toHaveLength(7);
  });

  it("caps at MAX 100 for large limits", async () => {
    for (const big of [200, 999, Number.MAX_SAFE_INTEGER]) {
      const { result, getMemories } = await probe(big);
      expect(result, `limit=${big}`).toHaveLength(MAX_CHARACTER_HISTORY_LIMIT);
      expect(getMemories).toHaveBeenCalledWith(
        expect.objectContaining({ count: MAX_CHARACTER_HISTORY_LIMIT * 4 }),
      );
    }
  });

  it("keeps non-finite fallback distinct from maximum and minimum limits", async () => {
    const { result: inf } = await probe(Number.POSITIVE_INFINITY);
    expect(inf).toHaveLength(20);
    expect(inf).not.toHaveLength(100);
    const { result: zero } = await probe(0);
    expect(zero).toHaveLength(1);
    expect(zero).not.toHaveLength(20);
  });

  it("omits poisoned rows and fills the requested limit with adjacent valid history", async () => {
    const poisoned = makeMemory(2000);
    const cyclic: Record<string, unknown> = { name: "poisoned" };
    cyclic.self = cyclic;
    poisoned.metadata.before = cyclic;
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
    overDepth.metadata.before = nested;
    for (let depth = 0; depth <= 64; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    const overNode = makeMemory(2000);
    const sparse: unknown[] = [];
    sparse.length = 100_001;
    overNode.metadata.before = { messageExamples: sparse };
    const valid = [makeMemory(1999), makeMemory(1998), makeMemory(1997)];
    const getMemories = vi.fn(async () => [overDepth, overNode, ...valid]);
    const runtime = { agentId: "agent-123", getMemories } as never;

    const result = await listCharacterHistory(runtime, 2);

    expect(result.map((entry) => entry.id)).toEqual(["m-1999", "m-1998"]);
    expect(result).toHaveLength(2);
  });
});
