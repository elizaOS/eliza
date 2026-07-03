/**
 * `KNOWLEDGE_GRAPH` action — unit tests.
 *
 * Mocks `@elizaos/agent` (`hasOwnerAccess` + `resolveKnowledgeGraphService`)
 * so the suite exercises the action's op dispatch against a fake
 * EntityStore/RelationshipStore without a DB. Asserts create / read / list /
 * log_interaction / set_identity / set_relationship / merge dispatch onto the
 * right store method with the right shape, plus the owner-access and
 * missing-op/-field failure gates.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import type { Entity, EntityIdentity, Relationship } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  resolveKnowledgeGraphService: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
  resolveKnowledgeGraphService: mocks.resolveKnowledgeGraphService,
}));

import { entityAction } from "../src/actions/entity.ts";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entityId: "ent_1",
    type: "person",
    preferredName: "Alice",
    identities: [],
    state: {},
    tags: [],
    visibility: "owner_agent_admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRelationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    relationshipId: "rel_1",
    fromEntityId: "self",
    toEntityId: "ent_1",
    type: "manages",
    state: {},
    evidence: ["user_chat"],
    confidence: 1,
    source: "user_chat",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type FakeStores = {
  entityStore: {
    upsert: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    recordInteraction: ReturnType<typeof vi.fn>;
    observeIdentity: ReturnType<typeof vi.fn>;
    merge: ReturnType<typeof vi.fn>;
  };
  relationshipStore: {
    upsert: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
};

function makeStores(): FakeStores {
  return {
    entityStore: {
      upsert: vi.fn(async (input: Record<string, unknown>) =>
        makeEntity(input as Partial<Entity>),
      ),
      get: vi.fn(async () => makeEntity()),
      list: vi.fn(async () => [makeEntity()]),
      recordInteraction: vi.fn(async () => undefined),
      observeIdentity: vi.fn(async () => ({ entity: makeEntity() })),
      merge: vi.fn(async () => makeEntity()),
    },
    relationshipStore: {
      upsert: vi.fn(async (input: Record<string, unknown>) =>
        makeRelationship(input as Partial<Relationship>),
      ),
      list: vi.fn(async () => [makeRelationship()]),
    },
  };
}

function makeService(stores: FakeStores) {
  return {
    getEntityStore: vi.fn(() => stores.entityStore),
    getRelationshipStore: vi.fn(() => stores.relationshipStore),
  };
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-rel-test" as UUID,
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "graph op"): Memory {
  return {
    id: "msg-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-1" as UUID,
    content: { text },
  } as Memory;
}

async function call(
  parameters: Record<string, unknown>,
  options: Partial<HandlerOptions> = {},
) {
  return entityAction.handler(
    makeRuntime(),
    makeMessage(),
    undefined,
    { ...options, parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("KNOWLEDGE_GRAPH action", () => {
  let stores: FakeStores;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasOwnerAccess.mockResolvedValue(true);
    stores = makeStores();
    mocks.resolveKnowledgeGraphService.mockReturnValue(makeService(stores));
  });

  it("is named KNOWLEDGE_GRAPH (not ENTITY)", () => {
    expect(entityAction.name).toBe("KNOWLEDGE_GRAPH");
  });

  it("denies non-owners", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(false);
    const result = await call({ op: "list" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PERMISSION_DENIED" });
    expect(stores.entityStore.list).not.toHaveBeenCalled();
  });

  it("fails when the service is unavailable", async () => {
    mocks.resolveKnowledgeGraphService.mockReturnValueOnce(null);
    const result = await call({ op: "list" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  it("rejects an unknown / missing op", async () => {
    const result = await call({ op: "not_a_real_op" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "MISSING_OP" });
  });

  it("create dispatches entityStore.upsert with the kind + name", async () => {
    const result = await call({
      op: "create",
      kind: "organization",
      name: "Acme",
    });
    expect(result?.success).toBe(true);
    expect(stores.entityStore.upsert).toHaveBeenCalledTimes(1);
    expect(stores.entityStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "organization", preferredName: "Acme" }),
    );
  });

  it("create defaults kind to person and fails without a name", async () => {
    const ok = await call({ op: "create", name: "Bob" });
    expect(stores.entityStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "person", preferredName: "Bob" }),
    );
    expect(ok?.success).toBe(true);

    const bad = await call({ op: "create" });
    expect(bad?.success).toBe(false);
    expect(bad?.data).toMatchObject({ error: "MISSING_FIELDS" });
  });

  it("read fetches by id and surfaces NOT_FOUND", async () => {
    const result = await call({ op: "read", entityId: "ent_1" });
    expect(stores.entityStore.get).toHaveBeenCalledWith("ent_1");
    expect(result?.success).toBe(true);

    stores.entityStore.get.mockResolvedValueOnce(null);
    const missing = await call({ op: "read", entityId: "ent_x" });
    expect(missing?.success).toBe(false);
    expect(missing?.data).toMatchObject({ error: "NOT_FOUND" });
  });

  it("list passes the kind filter + limit", async () => {
    await call({ op: "list", kind: "person", limit: 10 });
    expect(stores.entityStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: "person", limit: 10 }),
    );
  });

  it("log_interaction records on the entity", async () => {
    const result = await call({
      op: "log_interaction",
      entityId: "ent_1",
      platform: "telegram",
      direction: "inbound",
      summary: "called about the deal",
    });
    expect(result?.success).toBe(true);
    expect(stores.entityStore.recordInteraction).toHaveBeenCalledWith(
      "ent_1",
      expect.objectContaining({
        platform: "telegram",
        direction: "inbound",
        summary: "called about the deal",
      }),
    );
  });

  it("set_identity observes but does not verify without trusted proof", async () => {
    const observed = makeEntity({
      identities: [
        {
          platform: "slack",
          handle: "@pat",
          verified: false,
          confidence: 1,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "platform_observation",
          evidence: ["user_chat"],
        } satisfies EntityIdentity,
      ],
    });
    stores.entityStore.observeIdentity.mockResolvedValueOnce({
      entity: observed,
      mergedFrom: ["ent_2"],
    });

    const result = await call({
      op: "set_identity",
      platform: "slack",
      handle: "@pat",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      error: "IDENTITY_VERIFICATION_REQUIRED",
      mergedFrom: ["ent_2"],
    });
    expect(stores.entityStore.observeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "slack",
        handle: "@pat",
        confidence: 1,
      }),
    );
    expect(stores.entityStore.upsert).not.toHaveBeenCalled();
  });

  it("set_identity marks verified only with trusted matching proof", async () => {
    const observed = makeEntity({
      identities: [
        {
          platform: "slack",
          handle: "@pat",
          verified: false,
          confidence: 1,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "platform_observation",
          evidence: ["user_chat"],
        } satisfies EntityIdentity,
      ],
    });
    stores.entityStore.observeIdentity.mockResolvedValueOnce({
      entity: observed,
      mergedFrom: ["ent_2"],
    });

    const result = await call(
      {
        op: "set_identity",
        platform: "slack",
        handle: "@pat",
      },
      {
        identityVerification: {
          platform: "slack",
          handle: "@pat",
          verified: true,
          evidence: "slack_oauth_subject_match",
        },
      } as Partial<HandlerOptions>,
    );

    expect(result?.success).toBe(true);
    const upsertArg = stores.entityStore.upsert.mock.calls.at(
      -1,
    )?.[0] as Entity;
    const reasserted = upsertArg.identities.find(
      (identity) => identity.platform === "slack" && identity.handle === "@pat",
    );
    expect(reasserted?.verified).toBe(true);
    expect(reasserted?.evidence).toEqual([
      "user_chat",
      "slack_oauth_subject_match",
    ]);
    expect(result?.data).toMatchObject({ mergedFrom: ["ent_2"] });
  });

  it("set_identity fails without platform + handle", async () => {
    const result = await call({ op: "set_identity", platform: "slack" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "MISSING_FIELDS" });
    expect(stores.entityStore.observeIdentity).not.toHaveBeenCalled();
  });

  it("set_relationship upserts a typed edge, defaulting from to self", async () => {
    const result = await call({
      op: "set_relationship",
      toEntityId: "ent_1",
      relationshipType: "manages",
    });
    expect(result?.success).toBe(true);
    expect(stores.relationshipStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEntityId: "self",
        toEntityId: "ent_1",
        type: "manages",
        source: "user_chat",
        confidence: 1,
      }),
    );
  });

  it("set_relationship honors an explicit fromEntityId", async () => {
    await call({
      op: "set_relationship",
      fromEntityId: "ent_2",
      toEntityId: "ent_1",
      relationshipType: "works_at",
    });
    expect(stores.relationshipStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ fromEntityId: "ent_2", toEntityId: "ent_1" }),
    );
  });

  it("set_relationship fails without target + type", async () => {
    const result = await call({ op: "set_relationship", toEntityId: "ent_1" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "MISSING_FIELDS" });
    expect(stores.relationshipStore.upsert).not.toHaveBeenCalled();
  });

  it("merge folds sources into a target", async () => {
    stores.entityStore.merge.mockResolvedValueOnce(
      makeEntity({ entityId: "ent_1", preferredName: "Alice" }),
    );
    const result = await call({
      op: "merge",
      entityId: "ent_1",
      sourceEntityIds: ["ent_2", "ent_3"],
    });
    expect(result?.success).toBe(true);
    expect(stores.entityStore.merge).toHaveBeenCalledWith("ent_1", [
      "ent_2",
      "ent_3",
    ]);
    expect(result?.data).toMatchObject({ sourceEntityIds: ["ent_2", "ent_3"] });
  });

  it("merge fails without a target + at least one source", async () => {
    const noSources = await call({ op: "merge", entityId: "ent_1" });
    expect(noSources?.success).toBe(false);
    expect(noSources?.data).toMatchObject({ error: "MISSING_FIELDS" });
    expect(stores.entityStore.merge).not.toHaveBeenCalled();
  });

  it("accepts the `action` alias for the op field", async () => {
    const result = await call({ action: "create", name: "Carol" });
    expect(result?.success).toBe(true);
    expect(stores.entityStore.upsert).toHaveBeenCalled();
  });
});
