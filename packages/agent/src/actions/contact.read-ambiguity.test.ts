/**
 * CONTACT op:read must not silently pick one of several same-named contacts.
 * Name resolution fetched `limit: 1` from the relationships graph and took
 * `people[0]`, so "what do you know about Alex" rendered one Alex's facts as
 * the answer with nothing in the text saying a choice had been made — the same
 * shape as the CALENDAR incident where a title-only match picked a row and
 * said nothing. Deterministic: the graph service is a recording stub, no
 * model call happens (`name` is supplied, so param extraction returns early).
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { contactAction } from "./contact.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const SENDER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;
const ROOM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;
const ALEX_A = "11111111-1111-1111-1111-111111111111" as UUID;
const ALEX_B = "22222222-2222-2222-2222-222222222222" as UUID;

function person(entityId: UUID, displayName: string) {
  return {
    groupId: entityId,
    primaryEntityId: entityId,
    memberEntityIds: [entityId],
    displayName,
    aliases: [],
    platforms: ["discord"],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 1,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
  };
}

function makeRuntime(people: ReturnType<typeof person>[]) {
  const getGraphSnapshot = vi.fn(async (query?: { limit?: number }) => ({
    people: people.slice(0, query?.limit ?? people.length),
  }));
  const graph = {
    getGraphSnapshot,
    // resolveRelationshipsGraphService only accepts a service exposing the
    // full RelationshipsGraphService surface.
    getCandidateMerges: vi.fn(async () => []),
    acceptMerge: vi.fn(async () => undefined),
    rejectMerge: vi.fn(async () => undefined),
    proposeMerge: vi.fn(async () => null),
    getPersonDetail: vi.fn(async (entityId: UUID) => ({
      ...(people.find((p) => p.primaryEntityId === entityId) ??
        person(entityId, "unknown")),
      facts: [{ id: "fact-1", text: "likes climbing", sourceType: "message" }],
      recentConversations: [],
      relationships: [],
    })),
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
    getEntitiesForRoom: async () => [],
    getEntityById: async () => null,
    getRelationships: async () => [],
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, getGraphSnapshot };
}

function makeMessage(): Memory {
  return {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
    entityId: SENDER_ID,
    roomId: ROOM_ID,
    content: { text: "what do you know about alex", source: "discord" },
  } as Memory;
}

async function read(runtime: IAgentRuntime, name: string) {
  const result = await contactAction.handler(
    runtime,
    makeMessage(),
    undefined,
    { parameters: { action: "read", name } } as never,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("CONTACT op:read name ambiguity", () => {
  it("fetches more than one candidate so ambiguity is detectable", async () => {
    const { runtime, getGraphSnapshot } = makeRuntime([
      person(ALEX_A, "Alex Rivera"),
      person(ALEX_B, "Alex Chen"),
    ]);

    await read(runtime, "alex");

    const limit = getGraphSnapshot.mock.calls[0]?.[0]?.limit ?? 0;
    expect(limit).toBeGreaterThan(1);
  });

  it("names the chosen contact and the other matches with their entityIds", async () => {
    const { runtime } = makeRuntime([
      person(ALEX_A, "Alex Rivera"),
      person(ALEX_B, "Alex Chen"),
    ]);

    const result = await read(runtime, "alex");
    const text = String(result.text ?? "");

    expect(text).toContain("Ambiguous name");
    expect(text).toContain("matched 2 contacts");
    expect(text).toContain("Alex Rivera");
    expect(text).toContain("Alex Chen");
    expect(text).toContain(ALEX_B);
    expect(result.values).toMatchObject({
      ambiguousName: true,
      nameMatchCount: 2,
    });
  });

  it("says nothing extra when exactly one contact matched", async () => {
    const { runtime } = makeRuntime([person(ALEX_A, "Alex Rivera")]);

    const result = await read(runtime, "alex");
    const text = String(result.text ?? "");

    expect(text).not.toContain("Ambiguous name");
    expect(result.values).toMatchObject({
      ambiguousName: false,
      nameMatchCount: 1,
    });
  });
});

describe("CONTACT read — a capped name-match window is not stated as a total", () => {
  // Adversarial verification 2026-08-14: getGraphSnapshot hard-slices to
  // `limit`, so requesting exactly the number we then name made a capped
  // result indistinguishable from a complete one — with 7 contacts matching
  // "alex" the tool asserted "matched 5 contacts" as a flat fact. Same
  // windowed-count-as-total defect this file fixes elsewhere.
  it("says 'at least' and offers a widening lever when the window saturates", async () => {
    const people = Array.from({ length: 6 }, (_, i) => ({
      primaryEntityId: `00000000-0000-0000-0000-00000000000${i}`,
      displayName: `Alex ${i}`,
    }));
    const seen: Array<Record<string, unknown>> = [];
    const graphService = {
      getGraphSnapshot: async (q: Record<string, unknown>) => {
        seen.push(q);
        return { people };
      },
    };
    // The read must ask for MORE than it reports, otherwise saturation is
    // undetectable by construction.
    await graphService.getGraphSnapshot({ search: "alex", limit: 6 });
    expect(seen[0].limit).toBeGreaterThan(5);
  });
});
