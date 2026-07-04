/**
 * `ENTITY_GRAPH` provider — unit tests.
 *
 * Mocks `@elizaos/agent`'s `resolveKnowledgeGraphService` so the provider
 * projects a fake EntityStore/RelationshipStore. Asserts the empty-graph
 * fallback, the service-absent fallback, the populated projection (entity
 * lines + ego-network edge lines with resolved target names, `self` excluded),
 * and the failure path (#12744: a store read failure must render a
 * distinguishable degraded shape + surface via `runtime.reportError`, never
 * the designed empty-graph result).
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import type { Entity, Relationship } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveKnowledgeGraphService: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  resolveKnowledgeGraphService: mocks.resolveKnowledgeGraphService,
}));

import { entityGraphProvider } from "../src/providers/entity-graph.ts";

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
    evidence: [],
    confidence: 1,
    source: "user_chat",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeService(args: {
  entities: Entity[];
  relationships: Relationship[];
}) {
  const entityStore = { list: vi.fn(async () => args.entities) };
  const relationshipStore = { list: vi.fn(async () => args.relationships) };
  return {
    service: {
      getEntityStore: () => entityStore,
      getRelationshipStore: () => relationshipStore,
    },
    entityStore,
    relationshipStore,
  };
}

const reportError = vi.fn();
const runtime = {
  agentId: "agent-1" as UUID,
  reportError,
} as unknown as IAgentRuntime;
const message = { id: "m1" as UUID, content: { text: "" } } as Memory;
const state = {} as State;

describe("ENTITY_GRAPH provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty projection when the service is absent", async () => {
    mocks.resolveKnowledgeGraphService.mockReturnValue(null);
    const result = await entityGraphProvider.get(runtime, message, state);
    expect(result).toEqual({
      text: "",
      data: { entities: [], relationships: [] },
    });
  });

  it("returns an empty projection when the graph is empty", async () => {
    const { service } = makeService({ entities: [], relationships: [] });
    mocks.resolveKnowledgeGraphService.mockReturnValue(service);
    const result = await entityGraphProvider.get(runtime, message, state);
    expect(result.text).toBe("");
    expect(result.data).toEqual({ entities: [], relationships: [] });
  });

  it("projects entities + ego edges and resolves target names", async () => {
    const { service, entityStore, relationshipStore } = makeService({
      entities: [
        makeEntity({ entityId: "self", preferredName: "self" }),
        makeEntity({
          entityId: "ent_1",
          preferredName: "Alice",
          type: "person",
          identities: [
            {
              platform: "slack",
              handle: "@alice",
              verified: true,
              confidence: 1,
              addedAt: "2026-01-01T00:00:00.000Z",
              addedVia: "user_chat",
              evidence: [],
            },
          ],
        }),
      ],
      relationships: [
        makeRelationship({ toEntityId: "ent_1", type: "manages" }),
      ],
    });
    mocks.resolveKnowledgeGraphService.mockReturnValue(service);

    const result = await entityGraphProvider.get(runtime, message, state);

    // self entity is excluded from the projected node list.
    expect(result.data?.entities).toEqual([
      {
        entityId: "ent_1",
        type: "person",
        preferredName: "Alice",
        platforms: ["slack"],
      },
    ]);
    expect(result.data?.relationships).toEqual([
      { fromEntityId: "self", toEntityId: "ent_1", type: "manages" },
    ]);
    // edge label resolves the target id to its preferred name.
    expect(result.text).toContain("you -[manages]-> Alice");
    expect(result.text).toContain("Alice (person)");
    // queried from `self` ego-network only.
    expect(relationshipStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ fromEntityId: "self" }),
    );
    expect(entityStore.list).toHaveBeenCalled();
  });

  it("renders a degraded error shape and reports when the store read fails", async () => {
    const boom = new Error("graph db unavailable");
    const service = {
      getEntityStore: () => ({
        list: vi.fn(async () => {
          throw boom;
        }),
      }),
      getRelationshipStore: () => ({ list: vi.fn(async () => []) }),
    };
    mocks.resolveKnowledgeGraphService.mockReturnValue(service);

    const result = await entityGraphProvider.get(runtime, message, state);

    // NOT the designed empty-graph shape: the non-empty error text is
    // prompt-visible (the runtime only injects non-empty provider text) and
    // the error marker distinguishes a broken graph read from a legitimately
    // empty graph.
    expect(result.text).toBe("Error retrieving entity graph");
    expect(result.data).toEqual({
      entities: [],
      relationships: [],
      error: "graph db unavailable",
    });
    expect(result.values).toEqual({
      entityGraphError: "graph db unavailable",
    });
    // The failure is observable in RECENT_ERRORS / owner-escalation.
    expect(reportError).toHaveBeenCalledWith("ENTITY_GRAPH.provider", boom);
  });

  it("does not report designed-absence or empty-graph states", async () => {
    mocks.resolveKnowledgeGraphService.mockReturnValue(null);
    await entityGraphProvider.get(runtime, message, state);
    const { service } = makeService({ entities: [], relationships: [] });
    mocks.resolveKnowledgeGraphService.mockReturnValue(service);
    await entityGraphProvider.get(runtime, message, state);
    expect(reportError).not.toHaveBeenCalled();
  });
});
