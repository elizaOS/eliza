/**
 * MEMORY delete-by-query on an augmented turn: the chat route can wrap the
 * request in a document-augmentation envelope before the action runs. The
 * delete fallback query must come from the user's words inside the envelope,
 * not the whole envelope: the every-term match bar (score >= 1) fails when
 * instruction lines and document fragments join the query, so an augmented
 * "forget my favorite tea" turn must delete the same stored fact as the
 * plain turn.
 */

import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { memoryAction } from "./memories.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const FACT_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "If the answer appears verbatim in the contextual documents, repeat it exactly.",
  "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
  "",
  "<contextual_documents>",
  "<source title=\"office notes\" similarity=\"0.900\">",
  "The office wifi password rotates every Monday.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "forget my favorite tea",
  "</user_request>",
].join("\n");

function makeRuntime() {
  const store: Memory[] = [
    {
      id: FACT_ID,
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "My favorite tea is matcha" },
      createdAt: 1_700_000_000_000,
    } as Memory,
  ];
  const deleted: string[] = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getService: () => undefined,
    countMemories: async (params: { tableName?: string }) =>
      params.tableName === "facts" ? store.length : 0,
    getMemories: async (params: { tableName?: string }) =>
      params.tableName === "facts" ? [...store] : [],
    deleteMemory: async (id: UUID) => {
      deleted.push(id);
      const index = store.findIndex((memory) => memory.id === id);
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as IAgentRuntime;
  return { runtime, store, deleted };
}

function msg(text: string): Memory {
  return {
    id: MESSAGE_ID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "discord" },
  } as Memory;
}

const state = { values: {}, data: {}, text: "" } as State;
const opts = {
  parameters: { action: "delete", confirm: true },
} as HandlerOptions;

describe("MEMORY delete-by-query on an augmented turn", () => {
  it("deletes the stored fact from the plain request", async () => {
    const { runtime, store, deleted } = makeRuntime();
    const result = await memoryAction.handler(
      runtime,
      msg("forget my favorite tea"),
      state,
      opts,
    );
    expect(result.success).toBe(true);
    expect(deleted).toEqual([FACT_ID]);
    expect(store).toHaveLength(0);
  });

  it("deletes the same stored fact from the augmented request", async () => {
    const { runtime, store, deleted } = makeRuntime();
    const result = await memoryAction.handler(
      runtime,
      msg(AUGMENTED_TEXT),
      state,
      opts,
    );
    expect(result.success).toBe(true);
    expect(deleted).toEqual([FACT_ID]);
    expect(store).toHaveLength(0);
  });
});
