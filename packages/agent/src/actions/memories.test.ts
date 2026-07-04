/**
 * MEMORY action handler tests against a deterministic in-memory runtime that
 * mimics the SQL adapter's contract: uuid params are type-checked like a
 * postgres uuid column (bad ids throw a drizzle-style error carrying the raw
 * SQL) and the relationships service exposes identity-cluster membership.
 */
import type { ActionResult, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { normalizeActionIdentifier } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { memoryAction } from "./memories";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const SIBLING_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;

type StoredRow = { memory: Memory; tableName: string; unique?: boolean };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidOrThrowLikeDrizzle(value: unknown, column: string): void {
  if (value == null) return;
  if (typeof value === "string" && UUID_RE.test(value)) return;
  throw new Error(
    `Failed query: select "id", "content" from "memories" where "${column}" = $1 -- params: ["${String(value)}"]; invalid input syntax for type uuid`,
  );
}

function makeRuntime(options?: {
  clusters?: Partial<Record<string, UUID[]>>;
}): { runtime: IAgentRuntime; rows: StoredRow[] } {
  const rows: StoredRow[] = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getService: (name: string) => {
      if (name === "relationships" && options?.clusters) {
        return {
          getMemberEntityIds: async (entityId: UUID) =>
            options.clusters?.[entityId] ?? [],
        };
      }
      return null;
    },
    createMemory: async (
      memory: Memory,
      tableName: string,
      unique?: boolean,
    ) => {
      rows.push({ memory, tableName, unique });
      return memory.id;
    },
    getMemories: async (params: {
      tableName: string;
      roomId?: UUID;
      entityId?: UUID;
    }) => {
      assertUuidOrThrowLikeDrizzle(params.roomId, "roomId");
      assertUuidOrThrowLikeDrizzle(params.entityId, "entityId");
      return rows
        .filter((row) => row.tableName === params.tableName)
        .filter((row) => !params.roomId || row.memory.roomId === params.roomId)
        .filter(
          (row) => !params.entityId || row.memory.entityId === params.entityId,
        )
        .map((row) => row.memory);
    },
    getMemoryById: async (memoryId: UUID) => {
      assertUuidOrThrowLikeDrizzle(memoryId, "id");
      return rows.find((row) => row.memory.id === memoryId)?.memory ?? null;
    },
    deleteMemory: async (memoryId: UUID) => {
      assertUuidOrThrowLikeDrizzle(memoryId, "id");
      const index = rows.findIndex((row) => row.memory.id === memoryId);
      if (index >= 0) rows.splice(index, 1);
    },
  } as unknown as IAgentRuntime;
  return { runtime, rows };
}

function seedFact(
  rows: StoredRow[],
  fields: { text: string; entityId: UUID; roomId?: UUID },
): UUID {
  const id = crypto.randomUUID() as UUID;
  rows.push({
    memory: {
      id,
      entityId: fields.entityId,
      agentId: AGENT_ID,
      roomId: fields.roomId ?? ROOM_ID,
      content: { text: fields.text },
      createdAt: Date.now(),
    } as Memory,
    tableName: "facts",
  });
  return id;
}

function makeMessage(): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: "remember this: my favorite color is blue" },
    createdAt: Date.now(),
  } as Memory;
}

type TestParams = Record<string, string | string[] | number | boolean>;

async function runAction(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: TestParams,
): Promise<ActionResult> {
  const result = await memoryAction.handler(runtime, message, undefined, {
    parameters,
  });
  if (!result) throw new Error("handler returned no result");
  return result;
}

async function runCreate(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: TestParams,
): Promise<ActionResult> {
  return runAction(runtime, message, { action: "create", ...parameters });
}

describe("MEMORY op:create", () => {
  it("persists to the facts table scoped to the conversation room and speaker", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();

    const result = await runCreate(runtime, message, {
      text: "the user's favorite color is blue",
      kind: "preference",
      tags: ["color"],
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(1);
    const { memory, tableName, unique } = rows[0];
    expect(tableName).toBe("facts");
    expect(unique).toBe(true);
    expect(memory.entityId).toBe(USER_ID);
    expect(memory.roomId).toBe(ROOM_ID);
    expect(memory.content.text).toBe("the user's favorite color is blue");

    const metadata = memory.metadata as Record<string, unknown>;
    expect(metadata.kind).toBe("durable");
    expect(metadata.category).toBe("preference");
    expect(metadata.keywords).toEqual(["color"]);
    expect(metadata.confidence).toBeGreaterThan(0.7);
    expect(metadata.verificationStatus).toBe("self_reported");
  });

  it("is retrievable by the FACTS provider candidate queries", async () => {
    // The FACTS provider builds two candidate pools over the `facts` table:
    // one scoped to the conversation room, one to the speaker's entity ids.
    // The old write (agent-scoped `memories` table in a synthetic room)
    // matched neither, so the saved fact could never be recalled.
    const { runtime } = makeRuntime();
    await runCreate(runtime, makeMessage(), {
      text: "the user's dog is named Jeff",
    });

    const roomPool = await runtime.getMemories({
      tableName: "facts",
      roomId: ROOM_ID,
    });
    expect(roomPool).toHaveLength(1);
    expect(roomPool[0].content.text).toBe("the user's dog is named Jeff");

    const entityPool = await runtime.getMemories({
      tableName: "facts",
      entityId: USER_ID,
    });
    expect(entityPool).toHaveLength(1);
    expect(entityPool[0].content.text).toBe("the user's dog is named Jeff");
  });

  it("is found by MEMORY op:search after create", async () => {
    const { runtime } = makeRuntime();
    const message = makeMessage();
    await runCreate(runtime, message, {
      text: "the user's favorite color is blue",
    });

    const result = await runAction(runtime, message, {
      action: "search",
      query: "favorite color",
    });
    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("the user's favorite color is blue");
  });

  it("falls back to the agent entity when the message has none", async () => {
    const { runtime, rows } = makeRuntime();
    const message = {
      ...makeMessage(),
      entityId: undefined,
    } as unknown as Memory;
    const result = await runCreate(runtime, message, { text: "agent note" });
    expect(result.success).toBe(true);
    expect(rows[0].memory.entityId).toBe(AGENT_ID);
  });

  it("rejects an empty text", async () => {
    const { runtime, rows } = makeRuntime();
    const result = await runCreate(runtime, makeMessage(), { text: "   " });
    expect(result.success).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("MEMORY op:search identity-cluster expansion", () => {
  it("finds a fact stored under a cluster sibling of the requested entityId", async () => {
    // Live failure shape: the FACTS provider surfaced "nubs plays guitar"
    // (stored under sibling entity ids) while MEMORY search on the primary
    // entityId reported "Found 0 (total 0)". Search must read through the
    // same identity-cluster expansion the provider uses.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: USER_ID,
      query: "guitar",
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("nubs plays guitar");
  });

  it("still filters to the entity's own rows when no cluster resolver exists", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });
    seedFact(rows, { text: "someone else surfs", entityId: SIBLING_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: USER_ID,
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("nubs plays guitar");
  });
});

describe("MEMORY uuid validation", () => {
  it('handles roomId "general" without running the query or leaking SQL', async () => {
    // The mock getMemories throws a drizzle-style error (raw SQL included)
    // for any non-uuid id, so a passing test proves the query never ran.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      roomId: "general",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_INVALID_UUID",
    );
    expect(result.text).toContain('roomId "general"');
    expect(result.text?.toLowerCase()).not.toContain("failed query");
    expect(result.text?.toLowerCase()).not.toContain("select");
  });

  it("handles a partial-uuid entityId on search cleanly", async () => {
    const { runtime } = makeRuntime();
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: "0b8db237",
    });
    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_INVALID_UUID",
    );
    expect(result.text?.toLowerCase()).not.toContain("failed query");
  });

  it("handles a partial-uuid memoryId on delete cleanly", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      memoryId: "82bdd9bb",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_INVALID_UUID",
    );
    expect(result.text?.toLowerCase()).not.toContain("failed query");
    expect(rows).toHaveLength(1);
  });
});

describe("MEMORY op:delete by query", () => {
  it("resolves the fact by text and deletes every duplicate row of it", async () => {
    // Reflection dedup failures store the same fact several times (live: six
    // copies of "nubs plays guitar" across two sibling entity ids). One
    // logical fact -> all rows removed.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "nubs plays guitar",
      entityId: USER_ID,
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.content.text).toBe("nubs lives on a boat");
  });

  it("scopes delete-by-query to the requesting user's identity cluster", async () => {
    // Multi-user room: another entity holds a fact with the exact same text.
    // "Forget that I play guitar" from USER_ID must remove only USER_ID's
    // row — a text-only match would silently delete the other user's fact.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "i play guitar", entityId: USER_ID });
    seedFact(rows, { text: "i play guitar", entityId: OTHER_USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "i play guitar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.entityId).toBe(OTHER_USER_ID);
  });

  it("deletes cluster-sibling rows of the requester but not a third user's", async () => {
    // The requester scope is identity-cluster expanded (getRelatedEntityIds),
    // so duplicates stored under the requester's sibling ids are still one
    // logical fact — while an unrelated user's identical text stays out.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "i play guitar", entityId: USER_ID });
    seedFact(rows, { text: "i play guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "i play guitar", entityId: OTHER_USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "i play guitar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.entityId).toBe(OTHER_USER_ID);
  });

  it("refuses an ambiguous query matching distinct memories and lists ids", async () => {
    const { runtime, rows } = makeRuntime();
    const idA = seedFact(rows, {
      text: "nubs plays guitar",
      entityId: USER_ID,
    });
    const idB = seedFact(rows, {
      text: "nubs plays guitar hero on fridays",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "plays guitar",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_AMBIGUOUS_QUERY",
    );
    expect(result.text).toContain(idA);
    expect(result.text).toContain(idB);
    expect(rows).toHaveLength(2);
  });

  it("returns a clean not-found when no stored memory matches", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "rides a unicycle",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe("MEMORY_NOT_FOUND");
    expect(rows).toHaveLength(1);
  });

  it("still requires confirm:true before deleting by query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "nubs plays guitar",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_CONFIRMATION_REQUIRED",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("MEMORY routing aliases", () => {
  it("resolves planner-generated LIST_MEMORIES / SEARCH_MEMORY to MEMORY", () => {
    // Mirrors buildRuntimeActionLookup (core services/message.ts): canonical
    // action names claim their normalized identifier first, then similes fill
    // the remaining slots. Without these aliases a listing intent fell
    // through to VIEWS and errored.
    const lookup = new Map<string, string>();
    const actions = [memoryAction];
    for (const action of actions) {
      const normalized = normalizeActionIdentifier(action.name);
      if (normalized && !lookup.has(normalized))
        lookup.set(normalized, action.name);
    }
    for (const action of actions) {
      for (const simile of action.similes ?? []) {
        const normalized = normalizeActionIdentifier(simile);
        if (normalized && !lookup.has(normalized))
          lookup.set(normalized, action.name);
      }
    }

    expect(lookup.get(normalizeActionIdentifier("LIST_MEMORIES"))).toBe(
      "MEMORY",
    );
    expect(lookup.get(normalizeActionIdentifier("SEARCH_MEMORY"))).toBe(
      "MEMORY",
    );
  });
});
