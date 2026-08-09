/**
 * CONTACT search honest dead-end: a no-match search must check the CURRENT
 * room's participants before reporting "not found". "tell vega …" about a
 * channel participant previously dead-ended at the saved-contacts rolodex
 * ("couldn't find anyone named vega in the contacts") even though they were
 * standing in the room. Deterministic runtime stand-in; the relationships
 * graph is a recording stub; read-only — no send happens.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { contactAction } from "./contact.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const SENDER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;
const VEGA_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;

function makeRuntime(options: {
  roomEntities: Array<{
    id: UUID;
    names: string[];
    components?: Array<{ data?: Record<string, unknown> }>;
  }>;
}): IAgentRuntime {
  const graph = {
    getGraphSnapshot: vi.fn(async () => ({ people: [] })),
    getPersonDetail: vi.fn(async () => null),
    getCandidateMerges: vi.fn(async () => []),
    acceptMerge: vi.fn(async () => undefined),
    rejectMerge: vi.fn(async () => undefined),
    proposeMerge: vi.fn(async () => null),
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: () => undefined,
    getService: (type: string) => (type === "relationships" ? graph : null),
    getSearchCategory: () => {
      throw new Error("not registered");
    },
    registerSearchCategory: () => undefined,
    getRoom: async () => ({ id: ROOM_ID, source: "discord", name: "#general" }),
    getEntitiesForRoom: async () =>
      options.roomEntities.map((entity) => ({
        agentId: AGENT_ID,
        metadata: {},
        components: [],
        ...entity,
      })),
    getEntityById: async () => null,
    getRelationships: async () => [],
    reportError: vi.fn(),
  };
  return runtime as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
    entityId: SENDER_ID,
    roomId: ROOM_ID,
    content: { text, source: "discord" },
  } as Memory;
}

async function search(runtime: IAgentRuntime, query: string) {
  const result = await contactAction.handler(
    runtime,
    makeMessage(`tell ${query} to take a break`),
    undefined,
    { parameters: { action: "search", query } } as never,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("CONTACT search no-match room-participant hint", () => {
  it("surfaces a matching room participant instead of a bare dead-end", async () => {
    const runtime = makeRuntime({
      roomEntities: [
        { id: VEGA_ID, names: ["Vega"] },
        { id: AGENT_ID, names: ["Eliza"] },
      ],
    });
    const result = await search(runtime, "vega");

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({
      resultCount: 0,
      roomParticipantMatchCount: 1,
    });
    expect(result.data).toMatchObject({
      roomParticipantMatches: [{ entityId: VEGA_ID, name: "Vega" }],
    });
    // Planner-facing context: not a contact, but present in the channel — an
    // in-room reply can reach them. The model phrases the user-visible reply.
    expect(String(result.text)).toMatch(/present in the current room/i);
    expect(String(result.text)).toMatch(/Vega/);
  });

  it("never counts the agent itself as a participant match", async () => {
    const runtime = makeRuntime({
      roomEntities: [{ id: AGENT_ID, names: ["Eliza"] }],
    });
    const result = await search(runtime, "eliza");
    expect(result.values).toMatchObject({ roomParticipantMatchCount: 0 });
  });

  it("stays a plain honest no-match when nobody in the room matches", async () => {
    const runtime = makeRuntime({
      roomEntities: [{ id: VEGA_ID, names: ["Someone Else"] }],
    });
    const result = await search(runtime, "vega");

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({
      resultCount: 0,
      roomParticipantMatchCount: 0,
    });
    expect(String(result.text)).not.toMatch(/present in the current room/i);
  });
});
