import type { ActionResult, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { memoryAction } from "./memories";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;

type StoredRow = { memory: Memory; tableName: string; unique?: boolean };

function makeRuntime(): { runtime: IAgentRuntime; rows: StoredRow[] } {
  const rows: StoredRow[] = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
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
    }) =>
      rows
        .filter((row) => row.tableName === params.tableName)
        .filter((row) => !params.roomId || row.memory.roomId === params.roomId)
        .filter(
          (row) => !params.entityId || row.memory.entityId === params.entityId,
        )
        .map((row) => row.memory),
  } as unknown as IAgentRuntime;
  return { runtime, rows };
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

async function runAction(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, string | string[]>,
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
  parameters: Record<string, string | string[]>,
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
