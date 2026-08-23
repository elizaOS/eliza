/**
 * Regression for the two chat-route ordering comparators: the ascending
 * message-recency comparator used to rebuild local direct-chat history, and
 * the descending assistant-turn comparator used to pick the most recent
 * visible assistant memory. Drives the real exported comparators plus the
 * exported `getRecentVisibleAssistantMemorySince` with an in-memory runtime
 * stand-in — no live model and no copied comparator logic.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  compareAssistantTurnRecencyDescending,
  compareCreatedAtAscending,
  getRecentVisibleAssistantMemorySince,
} from "./chat-routes";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const TURN_A = "33333333-3333-3333-3333-333333333333" as UUID;
const TURN_B = "44444444-4444-4444-4444-444444444444" as UUID;

function assistantMemory(id: UUID, createdAt: number, text: string): Memory {
  return {
    id,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text },
    createdAt,
  } as unknown as Memory;
}

function runtimeReturning(memories: Memory[]): AgentRuntime {
  return {
    agentId: AGENT_ID,
    getMemories: async () => memories,
  } as unknown as AgentRuntime;
}

describe("compareCreatedAtAscending", () => {
  it("is antisymmetric and total when a createdAt is NaN", () => {
    const nanItem = { id: "msg-nan", createdAt: Number.NaN };
    const finiteItem = { id: "msg-100", createdAt: 100 };

    expect(compareCreatedAtAscending(nanItem, finiteItem)).toBeLessThan(0);
    expect(compareCreatedAtAscending(finiteItem, nanItem)).toBeGreaterThan(0);

    const items = [finiteItem, nanItem];
    items.sort(compareCreatedAtAscending);
    expect(items.map((item) => item.id)).toEqual(["msg-nan", "msg-100"]);
  });

  it("orders a missing createdAt before a finite one in both directions", () => {
    const missing = { id: "msg-missing" };
    const finite = { id: "msg-5", createdAt: 5 };

    expect(compareCreatedAtAscending(missing, finite)).toBeLessThan(0);
    expect(compareCreatedAtAscending(finite, missing)).toBeGreaterThan(0);
  });

  it("breaks equal-timestamp ties deterministically on ascending id", () => {
    const later = { id: "zzz", createdAt: 10 };
    const earlier = { id: "aaa", createdAt: 10 };

    expect(compareCreatedAtAscending(earlier, later)).toBeLessThan(0);
    expect(compareCreatedAtAscending(later, earlier)).toBeGreaterThan(0);

    const items = [later, earlier];
    items.sort(compareCreatedAtAscending);
    expect(items.map((item) => item.id)).toEqual(["aaa", "zzz"]);
  });

  it("keeps ordinary ascending order by timestamp", () => {
    const items = [
      { id: "c", createdAt: 300 },
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 200 },
    ];
    items.sort(compareCreatedAtAscending);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("compareAssistantTurnRecencyDescending", () => {
  it("treats a NaN createdAt as epoch zero instead of poisoning the order", () => {
    const nanTurn = { id: "turn-nan", createdAt: Number.NaN };
    const finiteTurn = { id: "turn-100", createdAt: 100 };

    expect(
      compareAssistantTurnRecencyDescending(nanTurn, finiteTurn),
    ).toBeGreaterThan(0);
    expect(
      compareAssistantTurnRecencyDescending(finiteTurn, nanTurn),
    ).toBeLessThan(0);

    const items = [nanTurn, finiteTurn];
    items.sort(compareAssistantTurnRecencyDescending);
    expect(items.map((item) => item.id)).toEqual(["turn-100", "turn-nan"]);
  });

  it("orders newest first and breaks ties on ascending id", () => {
    const items = [
      { id: "zzz", createdAt: 10 },
      { id: "aaa", createdAt: 10 },
      { id: "mmm", createdAt: 50 },
    ];
    items.sort(compareAssistantTurnRecencyDescending);
    expect(items.map((item) => item.id)).toEqual(["mmm", "aaa", "zzz"]);
  });
});

describe("getRecentVisibleAssistantMemorySince", () => {
  it("returns the newest visible assistant turn", async () => {
    const runtime = runtimeReturning([
      assistantMemory(TURN_A, 1_000, "older"),
      assistantMemory(TURN_B, 5_000, "newer"),
    ]);

    const result = await getRecentVisibleAssistantMemorySince(
      runtime,
      ROOM_ID,
      1_000,
    );

    expect(result).toEqual({ id: TURN_B, text: "newer" });
  });

  it("resolves equal-timestamp assistant turns deterministically by id", async () => {
    const storageOrder = await getRecentVisibleAssistantMemorySince(
      runtimeReturning([
        assistantMemory(TURN_B, 7_000, "b-turn"),
        assistantMemory(TURN_A, 7_000, "a-turn"),
      ]),
      ROOM_ID,
      7_000,
    );
    const reversedStorageOrder = await getRecentVisibleAssistantMemorySince(
      runtimeReturning([
        assistantMemory(TURN_A, 7_000, "a-turn"),
        assistantMemory(TURN_B, 7_000, "b-turn"),
      ]),
      ROOM_ID,
      7_000,
    );

    expect(storageOrder).toEqual({ id: TURN_A, text: "a-turn" });
    expect(reversedStorageOrder).toEqual(storageOrder);
  });
});
