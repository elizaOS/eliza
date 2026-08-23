/**
 * MEMORY op:search enumeration lane: "what have we talked about lately" is a
 * time-slice request, not a keyword lookup, so doSearch prepends a
 * chronological cross-room digest — but ONLY when the live delivery audience
 * is a verified owner-private destination. Both gate directions are covered
 * here (owner DM renders the digest; a mixed room degrades to the room-scoped
 * keyword scan with zero cross-room content), plus the query classifier and
 * the double-persisted-twin dedupe. Deterministic: @elizaos/core is partially
 * mocked to drive revalidateOwnerExclusiveDisclosure, and the runtime is an
 * in-memory fake.
 */
import type { ActionResult, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The action closes over revalidateOwnerExclusiveDisclosure from @elizaos/core
// at import time. Partially mock the module (same pattern as
// providers/relevant-conversations.test.ts) so each test drives the disclosure
// verdict while every other real export stays intact.
const revalidateOwnerExclusiveDisclosure = vi.fn();
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    revalidateOwnerExclusiveDisclosure: (
      ...args: Parameters<typeof actual.revalidateOwnerExclusiveDisclosure>
    ) => revalidateOwnerExclusiveDisclosure(...args),
  };
});

// Imported after the mock so the action binds the mocked disclosure check.
const { memoryAction } = await import("./memories");
const { OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS } = await import(
  "@elizaos/core"
);

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const DM_ROOM = "00000000-0000-0000-0000-0000000000c1" as UUID;
const OTHER_ROOM = "00000000-0000-0000-0000-0000000000c2" as UUID;

const HOUR = 60 * 60 * 1000;

type SeedMessage = {
  id?: UUID;
  roomId: UUID;
  entityId: UUID;
  text: string;
  createdAt: number;
};

function makeRuntime(seed: SeedMessage[]): IAgentRuntime {
  const messages: Memory[] = seed.map((row) => ({
    id: (row.id ?? (crypto.randomUUID() as UUID)) as UUID,
    entityId: row.entityId,
    agentId: AGENT_ID,
    roomId: row.roomId,
    content: { text: row.text },
    createdAt: row.createdAt,
  })) as Memory[];
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: () => undefined,
    // No relationships service: getRelatedEntityIds degrades to [entityId].
    getService: () => null,
    getRoomsForParticipant: async (_entityId: UUID) => [
      ...new Set(messages.map((m) => m.roomId)),
    ],
    getMemoriesByRoomIds: async (params: {
      tableName: string;
      roomIds: UUID[];
      limit?: number;
    }) => {
      const inScope = messages.filter((m) => params.roomIds.includes(m.roomId));
      return params.limit == null ? inScope : inScope.slice(0, params.limit);
    },
    // The keyword scan's windowed per-table read. Only the messages table has
    // rows here; other tables are empty.
    getMemories: async (params: {
      tableName: string;
      roomId?: UUID;
      limit?: number;
    }) => {
      if (params.tableName !== "messages") return [];
      const inScope = messages.filter(
        (m) => !params.roomId || m.roomId === params.roomId,
      );
      const limited =
        params.limit == null ? inScope : inScope.slice(-params.limit);
      return [...limited].reverse();
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: DM_ROOM,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

async function runSearch(
  runtime: IAgentRuntime,
  message: Memory,
  query: string,
): Promise<ActionResult> {
  const result = await memoryAction.handler(runtime, message, undefined, {
    parameters: { action: "search", query },
  });
  if (!result) throw new Error("handler returned no result");
  return result;
}

function allowOwnerPrivate(): void {
  revalidateOwnerExclusiveDisclosure.mockResolvedValue({
    allowed: true,
    basis: OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
    audience: {},
  });
}

function denyMixedRoom(): void {
  revalidateOwnerExclusiveDisclosure.mockResolvedValue({
    allowed: false,
    reason: "destination_not_private",
    audience: {},
  });
}

function recentSeed(): SeedMessage[] {
  const now = Date.now();
  return [
    {
      roomId: DM_ROOM,
      entityId: OWNER_ID,
      text: "the dmarz entropy talk on the roof went late",
      createdAt: now - 30 * HOUR,
    },
    {
      roomId: OTHER_ROOM,
      entityId: OWNER_ID,
      text: "ordered the alexis supplements finally",
      createdAt: now - 20 * HOUR,
    },
    {
      roomId: DM_ROOM,
      entityId: AGENT_ID,
      text: "logged the covenant follow-ups for tomorrow",
      createdAt: now - 10 * HOUR,
    },
  ];
}

describe("owner-private destination (gate open)", () => {
  it("prepends a chronological cross-room digest for a time-slice query", async () => {
    allowOwnerPrivate();
    const runtime = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.success).toBe(true);
    expect(result.values?.historyDigestIncluded).toBe(true);
    const text = result.text ?? "";
    expect(text).toContain("owner-private destination verified");
    // Cross-room: rows from BOTH rooms render.
    expect(text).toContain("dmarz entropy talk");
    expect(text).toContain("alexis supplements");
    expect(text).toContain("covenant follow-ups");
    // Chronological: oldest first, across rooms.
    const first = text.indexOf("dmarz entropy talk");
    const second = text.indexOf("alexis supplements");
    const third = text.indexOf("covenant follow-ups");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    // Speaker labels: the agent's own rows carry the character name.
    expect(text).toContain("Eliza: logged the covenant follow-ups");
  });

  it("renders double-persisted twin rows (same entityId+text) once", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const runtime = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "twin persisted line about the roof",
        createdAt: now - 6 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "twin persisted line about the roof",
        createdAt: now - 6 * HOUR + 250,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.values?.historyDigestIncluded).toBe(true);
    const text = result.text ?? "";
    const occurrences =
      text.split("twin persisted line about the roof").length - 1;
    expect(occurrences).toBe(1);
  });

  it("drops rows older than the digest window", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const runtime = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "ancient message from three weeks ago",
        createdAt: now - 21 * 24 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "fresh message from yesterday",
        createdAt: now - 20 * HOUR,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("what did we discuss the last few days"),
      "what did we discuss the last few days",
    );

    // The keyword lane below the digest may still match the old row (it
    // legitimately matches the query terms); the WINDOW claim is about the
    // digest section only, so scope the assertion to it.
    const text = result.text ?? "";
    const digestSection = text.slice(0, text.indexOf("Showing"));
    expect(digestSection).toContain("fresh message from yesterday");
    expect(digestSection).not.toContain("ancient message");
  });
});

describe("mixed room (gate closed)", () => {
  it("returns no digest and leaks no cross-room content when disclosure is denied", async () => {
    denyMixedRoom();
    const runtime = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.success).toBe(true);
    expect(revalidateOwnerExclusiveDisclosure).toHaveBeenCalled();
    expect(result.values?.historyDigestIncluded).toBe(false);
    const text = result.text ?? "";
    expect(text).not.toContain("owner-private destination verified");
    expect(text).not.toContain("Chronological conversation digest");
  });

  it("returns no digest when allowed but on a non-owner-private basis", async () => {
    // internal_agent_turn is an allowed basis for internal work, but it is
    // NOT a verified owner-only delivery audience, so the cross-room digest
    // must stay closed.
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: true,
      basis: "internal_agent_turn",
      audience: {},
    });
    const runtime = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.values?.historyDigestIncluded).toBe(false);
    expect(result.text ?? "").not.toContain(
      "Chronological conversation digest",
    );
  });
});

describe("query classification", () => {
  const enumerationQueries = [
    "what have we talked about lately",
    "recent logs",
    "what did we discuss the last few days",
    "lately",
    "catch me up",
  ];

  for (const query of enumerationQueries) {
    it(`treats "${query}" as a time-slice query`, async () => {
      allowOwnerPrivate();
      revalidateOwnerExclusiveDisclosure.mockClear();
      const runtime = makeRuntime(recentSeed());
      const result = await runSearch(runtime, makeMessage(query), query);
      // The enumeration lane ran: the owner-private gate was consulted and,
      // being open, the digest rendered.
      expect(revalidateOwnerExclusiveDisclosure).toHaveBeenCalled();
      expect(result.values?.historyDigestIncluded).toBe(true);
    });
  }

  it("does NOT treat a plain keyword lookup as a time-slice query", async () => {
    allowOwnerPrivate();
    revalidateOwnerExclusiveDisclosure.mockClear();
    const runtime = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("find the postgres migration"),
      "find the postgres migration",
    );
    // The enumeration lane never ran: no disclosure check, no digest.
    expect(revalidateOwnerExclusiveDisclosure).not.toHaveBeenCalled();
    expect(result.values?.historyDigestIncluded).toBe(false);
  });
});
