/**
 * Coverage for relevantConversationsProvider's recall paths: the shared per-turn
 * embed (embedRecallQuery) failing open to `null` (no vector search issued,
 * empty result), resolving to a vector (drives searchMemories), lexical
 * hash-memory recall surfacing even when the embed fails open, and short
 * messages short-circuiting before any embed. Deterministic: @elizaos/core is
 * partially mocked to drive embedRecallQuery, and the runtime's
 * searchMemories / getMemories are in-memory vi fakes.
 */
import type { IAgentRuntime, Memory, Room, State } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

// The provider closes over `embedRecallQuery` from @elizaos/core at import time.
// Partially mock the module so we can drive the shared recall embed to a
// resolved vector or a fail-open `null`, while keeping every other real export
// (relied on by @elizaos/shared and the provider's helper modules) intact.
const embedRecallQuery =
  vi.fn<(runtime: IAgentRuntime, text: string) => Promise<number[] | null>>();
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    embedRecallQuery: (runtime: IAgentRuntime, text: string) =>
      embedRecallQuery(runtime, text),
  };
});

// Imported after the mock so the provider binds the mocked embedder.
const { relevantConversationsProvider } = await import(
  "./relevant-conversations.ts"
);

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as Room["id"];
const OTHER_ROOM = "00000000-0000-0000-0000-0000000000c2" as Room["id"];

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): {
  runtime: IAgentRuntime;
  searchMemories: ReturnType<typeof vi.fn>;
} {
  const searchMemories = vi.fn(async () => [
    {
      id: "00000000-0000-0000-0000-0000000000m1",
      roomId: OTHER_ROOM,
      entityId: "00000000-0000-0000-0000-0000000000e1",
      content: { text: "earlier relevant message" },
      createdAt: 1,
    } as unknown as Memory,
  ]);
  const runtime = createMockRuntime({
    getRoom: vi.fn(async () => ({ id: ROOM_ID }) as unknown as Room),
    // Lexical hash-memory scan runs before the semantic embed; default to no
    // hash memories so these tests isolate the embed path.
    getMemories: vi.fn(async () => []),
    searchMemories,
    ...overrides,
  });
  return { runtime, searchMemories };
}

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    entityId: "00000000-0000-0000-0000-0000000000e0",
    agentId: "00000000-0000-0000-0000-0000000000ag",
    roomId: ROOM_ID,
    content: { text },
    createdAt: 2,
  } as unknown as Memory;
}

const EMPTY_STATE = { values: {}, data: {}, text: "" } as unknown as State;

describe("relevantConversationsProvider — shared recall embed fail-open", () => {
  afterEach(() => {
    embedRecallQuery.mockReset();
  });

  it("returns the empty result and never searches when the shared embed fails open (null)", async () => {
    embedRecallQuery.mockResolvedValue(null);
    const { runtime, searchMemories } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).toHaveBeenCalledWith(
      runtime,
      "what did we decide about the launch date",
    );
    // Fail-open: no vector search issued.
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it("uses the shared embed vector to search when it resolves", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const { runtime, searchMemories } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(embedRecallQuery).toHaveBeenCalledTimes(1);
    expect(searchMemories).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [0.1, 0.2, 0.3] }),
    );
    expect(result.text).toContain("Relevant past conversations:");
  });

  it("surfaces lexical hash memories even when the embed fails open (null)", async () => {
    embedRecallQuery.mockResolvedValue(null);
    const getMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000h1",
        roomId: "00000000-0000-0000-0000-0000000000hr",
        entityId: "00000000-0000-0000-0000-0000000000e9",
        content: {
          text: "the launch date is set for next Friday",
          source: "hash_memory",
        },
        createdAt: 5,
      } as unknown as Memory,
      {
        id: "00000000-0000-0000-0000-0000000000h2",
        roomId: "00000000-0000-0000-0000-0000000000hr",
        entityId: "00000000-0000-0000-0000-0000000000e9",
        content: { text: "unrelated note", source: "hash_memory" },
        createdAt: 6,
      } as unknown as Memory,
    ]);
    const { runtime, searchMemories } = makeRuntime({ getMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what is the launch date for the release"),
      EMPTY_STATE,
    );

    // No embed vector → no semantic search, but the lexical hit still surfaces.
    expect(searchMemories).not.toHaveBeenCalled();
    expect(result.text).toContain("Relevant past conversations:");
    expect(result.text).toContain("the launch date is set for next Friday");
    expect(result.text).not.toContain("unrelated note");
    expect(result.values?.relevantConversationCount).toBe(1);
  });

  it("short messages short-circuit before embedding", async () => {
    embedRecallQuery.mockResolvedValue([0.1]);
    const { runtime } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("hi"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).not.toHaveBeenCalled();
  });
});
