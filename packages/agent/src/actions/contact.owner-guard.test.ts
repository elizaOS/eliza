/**
 * CONTACT link/merge owner-authority guard: an ADMIN-rank sender must not be
 * able to create a confirmed identity link that touches an owner-equivalent
 * entity (configured canonical owner, deterministic fallback admin entity, or
 * the message world's owner) — that link would make role resolution treat them
 * as OWNER everywhere, bypassing canModifyRole's "ADMIN never grants OWNER"
 * rule. Authorization resolves through the REAL core role machinery against a
 * deterministic runtime stand-in; only the relationships graph service is a
 * recording stub.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contactAction } from "./contact.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;
const ADMIN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;
const OTHER_A = "11111111-1111-1111-1111-111111111111" as UUID;
const OTHER_B = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;
const CANDIDATE_ID = "99999999-9999-9999-9999-999999999999" as UUID;

type GraphStub = {
  getGraphSnapshot: ReturnType<typeof vi.fn>;
  getPersonDetail: ReturnType<typeof vi.fn>;
  getCandidateMerges: ReturnType<typeof vi.fn>;
  acceptMerge: ReturnType<typeof vi.fn>;
  rejectMerge: ReturnType<typeof vi.fn>;
  proposeMerge: ReturnType<typeof vi.fn>;
};

function makeGraphStub(candidatePair?: {
  entityA: UUID;
  entityB: UUID;
}): GraphStub {
  return {
    getGraphSnapshot: vi.fn(async () => ({ people: [] })),
    getPersonDetail: vi.fn(async () => null),
    getCandidateMerges: vi.fn(async () =>
      candidatePair
        ? [
            {
              id: CANDIDATE_ID,
              entityA: candidatePair.entityA,
              entityB: candidatePair.entityB,
              confidence: 1,
              evidence: {},
              status: "pending" as const,
              proposedAt: new Date().toISOString(),
            },
          ]
        : [],
    ),
    acceptMerge: vi.fn(async () => undefined),
    rejectMerge: vi.fn(async () => undefined),
    proposeMerge: vi.fn(async () => CANDIDATE_ID),
  };
}

function makeRuntime(graph: GraphStub): IAgentRuntime {
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getService: (type: string) => (type === "relationships" ? graph : null),
    getRoom: async () => null,
    getEntityById: async () => null,
    getRelationships: async () => [],
    reportError: vi.fn(),
    registerSearchCategory: () => undefined,
  };
  return runtime as unknown as IAgentRuntime;
}

function makeMessage(entityId: UUID, text = "link them"): Memory {
  return {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
    entityId,
    roomId: ROOM_ID,
    content: { text, source: "client_chat" },
  } as Memory;
}

async function runContact(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  const result = await contactAction.handler(runtime, message, undefined, {
    parameters,
  } as never);
  if (!result) {
    throw new Error("handler returned no result");
  }
  return result;
}

describe("CONTACT link — owner identity-link guard", () => {
  let graph: GraphStub;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    graph = makeGraphStub();
    runtime = makeRuntime(graph);
  });

  it("denies a non-owner sender linking their entity to the configured owner", async () => {
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      action: "link",
      entityA: ADMIN_ID,
      entityB: OWNER_ID,
      confirmation: true,
    });
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "OWNER_LINK_FORBIDDEN" });
    expect(graph.proposeMerge).not.toHaveBeenCalled();
    expect(graph.acceptMerge).not.toHaveBeenCalled();
  });

  it("denies a non-owner sender linking to the deterministic fallback admin entity", async () => {
    const fallbackOwner = stringToUuid("Eliza-admin-entity") as UUID;
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      action: "link",
      entityA: fallbackOwner,
      entityB: ADMIN_ID,
      confirmation: true,
    });
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "OWNER_LINK_FORBIDDEN" });
    expect(graph.proposeMerge).not.toHaveBeenCalled();
  });

  it("allows the canonical owner to link their own connector entity", async () => {
    const result = await runContact(runtime, makeMessage(OWNER_ID), {
      action: "link",
      entityA: OWNER_ID,
      entityB: OTHER_A,
      confirmation: true,
    });
    expect(result.success).toBe(true);
    expect(graph.proposeMerge).toHaveBeenCalledWith(
      OWNER_ID,
      OTHER_A,
      expect.anything(),
    );
    expect(graph.acceptMerge).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it("allows a non-owner sender to link two unrelated entities", async () => {
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      action: "link",
      entityA: OTHER_A,
      entityB: OTHER_B,
      confirmation: true,
    });
    expect(result.success).toBe(true);
    expect(graph.proposeMerge).toHaveBeenCalledWith(
      OTHER_A,
      OTHER_B,
      expect.anything(),
    );
  });
});

describe("CONTACT merge — owner identity-link guard", () => {
  it("denies a non-owner sender accepting a merge candidate that touches the owner", async () => {
    const graph = makeGraphStub({ entityA: ADMIN_ID, entityB: OWNER_ID });
    const runtime = makeRuntime(graph);
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      op: "merge",
      candidateId: CANDIDATE_ID,
      action: "accept",
    });
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "OWNER_LINK_FORBIDDEN" });
    expect(graph.acceptMerge).not.toHaveBeenCalled();
  });

  it("allows a non-owner sender to accept a merge between unrelated entities", async () => {
    const graph = makeGraphStub({ entityA: OTHER_A, entityB: OTHER_B });
    const runtime = makeRuntime(graph);
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      op: "merge",
      candidateId: CANDIDATE_ID,
      action: "accept",
    });
    expect(result.success).toBe(true);
    expect(graph.acceptMerge).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it("allows the owner to accept a merge candidate that touches the owner", async () => {
    const graph = makeGraphStub({ entityA: ADMIN_ID, entityB: OWNER_ID });
    const runtime = makeRuntime(graph);
    const result = await runContact(runtime, makeMessage(OWNER_ID), {
      op: "merge",
      candidateId: CANDIDATE_ID,
      action: "accept",
    });
    expect(result.success).toBe(true);
    expect(graph.acceptMerge).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it("rejecting a candidate needs no owner authority", async () => {
    const graph = makeGraphStub({ entityA: ADMIN_ID, entityB: OWNER_ID });
    const runtime = makeRuntime(graph);
    const result = await runContact(runtime, makeMessage(ADMIN_ID), {
      op: "merge",
      candidateId: CANDIDATE_ID,
      action: "reject",
    });
    expect(result.success).toBe(true);
    expect(graph.rejectMerge).toHaveBeenCalledWith(CANDIDATE_ID);
  });
});
