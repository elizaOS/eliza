/**
 * Real-PGlite DB round-trip test for the relationships data path.
 *
 * plugin-relationships is a VIEWER + KNOWLEDGE_GRAPH action over the runtime's
 * KnowledgeGraphService (owned by this plugin) — that service's
 * EntityStore / RelationshipStore are the relationships domain's real backing.
 * This boots a REAL PGLite-backed AgentRuntime, registers the KG service + its
 * schema, and round-trips entities + a relationship through the SAME stores the
 * relationships action drives — write → read back from the live
 * `app_lifeops.life_entities` / `life_relationships` tables (EntityStore.get /
 * .list / .resolve issue real SELECTs). No mocked adapter.
 */

import {
  type AgentRuntime,
  type Memory,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";
import { relationshipsPlugin as nativeRelationshipsPlugin } from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  KnowledgeGraphService,
  knowledgeGraphSchema,
  resolveKnowledgeGraphService,
} from "../src/index.ts";
import { relationshipsPlugin } from "../src/plugin.ts";

// Registering the KG service + schema makes runtime.initialize() start the
// service and migrate the app_lifeops knowledge-graph tables — exactly what the
// relationships action resolves at runtime via resolveKnowledgeGraphService.
const kgPlugin: Plugin = {
  name: "@elizaos/agent-knowledge-graph-test",
  description: "Test-only KnowledgeGraphService + schema bootstrap.",
  services: [KnowledgeGraphService],
  schema: knowledgeGraphSchema,
};

describe("relationships KnowledgeGraph backing — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: ReturnType<typeof resolveKnowledgeGraphService>;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "relationships-real-db",
      plugins: [nativeRelationshipsPlugin, kgPlugin, relationshipsPlugin],
    });
    runtime = testResult.runtime;
    service = resolveKnowledgeGraphService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("the runtime KnowledgeGraphService is registered + resolvable", () => {
    expect(service).toBeTruthy();
  });

  it("executes the external graph action after native relationships registration", async () => {
    const action = runtime.actions.find(
      (candidate) => candidate.name === "KNOWLEDGE_GRAPH",
    );
    if (!action) throw new Error("External graph action was not registered");
    const store = service?.getEntityStore();
    if (!store) throw new Error("EntityStore unavailable");
    const message: Memory = {
      id: stringToUuid("relationships-registration-owner-request"),
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: "Create a person named Registered Graph Person",
        source: "test",
      },
    };
    const result = await action.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          op: "create",
          kind: "person",
          name: "Registered Graph Person",
        },
      },
      undefined,
    );
    expect(result).toMatchObject({ success: true });
    const stored = (await store.list({ type: "person" })).find(
      (entity) => entity.preferredName === "Registered Graph Person",
    );
    if (!stored)
      throw new Error("Registered action did not persist its entity");
    expect((await store.get(stored.entityId))?.preferredName).toBe(
      "Registered Graph Person",
    );

    const denied = await action.handler(
      runtime,
      {
        ...message,
        id: stringToUuid("relationships-registration-guest-request"),
        entityId: stringToUuid("relationships-registration-guest"),
      },
      undefined,
      {
        parameters: {
          op: "create",
          kind: "person",
          name: "Denied Graph Person",
        },
      },
      undefined,
    );
    expect(denied).toMatchObject({
      success: false,
      data: { error: "PERMISSION_DENIED" },
    });
    expect(
      (await store.list({ type: "person" })).some(
        (entity) => entity.preferredName === "Denied Graph Person",
      ),
    ).toBe(false);
  });

  it("set_relationship updates the existing edge instead of adding a duplicate", async () => {
    const action = runtime.actions.find(
      (candidate) => candidate.name === "KNOWLEDGE_GRAPH",
    );
    if (!action) throw new Error("External graph action was not registered");
    const relationships = service?.getRelationshipStore();
    if (!relationships) throw new Error("RelationshipStore unavailable");
    const toEntityId = `ent_${stringToUuid("relationships-set-relationship-target")}`;
    const request = (evidence: string) => ({
      parameters: {
        op: "set_relationship",
        toEntityId,
        relationshipType: "manages",
        evidence,
      },
    });
    const message: Memory = {
      id: stringToUuid("relationships-set-relationship-owner"),
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: { text: "Pat is my manager", source: "test" },
    };

    const first = await action.handler(
      runtime,
      message,
      undefined,
      request("first chat"),
      undefined,
    );
    const second = await action.handler(
      runtime,
      message,
      undefined,
      request("second chat"),
      undefined,
    );

    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true });
    const edges = await relationships.list({ toEntityId, type: "manages" });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.evidence).toEqual(["first chat", "second chat"]);
  });

  it("concurrent assertions and observations of one edge keep one edge with every evidence", async () => {
    const relationships = service?.getRelationshipStore();
    if (!relationships) throw new Error("RelationshipStore unavailable");
    const edge = {
      fromEntityId: `ent_${stringToUuid("relationships-concurrent-from")}`,
      toEntityId: `ent_${stringToUuid("relationships-concurrent-to")}`,
      type: "knows",
    };
    const evidence = ["a", "b", "c", "d", "e"].map((tag) => `chat ${tag}`);

    await Promise.all(
      evidence.map((item) =>
        relationships.assertEdge({
          ...edge,
          evidence: [item],
          confidence: 0.5,
          source: "user_chat",
        }),
      ),
    );
    await Promise.all(
      ["f", "g", "h"].map((tag) =>
        relationships.observe({
          ...edge,
          evidence: [`chat ${tag}`],
          confidence: 0.5,
        }),
      ),
    );

    const edges = await relationships.list(edge);
    expect(edges).toHaveLength(1);
    expect([...(edges[0]?.evidence ?? [])].sort()).toEqual(
      [...evidence, "chat f", "chat g", "chat h"].sort(),
    );
    expect(edges[0]?.state.interactionCount).toBe(3);
  });

  it("entity upsert → get / list / resolve round-trip against the live DB", async () => {
    const store = service?.getEntityStore();
    if (!store) throw new Error("EntityStore unavailable");

    const created = await store.upsert({
      type: "person",
      preferredName: "Alice Example",
      identities: [],
      tags: ["vip"],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(created.entityId).toBeTruthy();

    // get() reads SELECT * FROM app_lifeops.life_entities — real DB read-back.
    const read = await store.get(created.entityId);
    expect(read?.preferredName).toBe("Alice Example");

    // list() filtered by type returns the persisted row.
    const people = await store.list({ type: "person" });
    expect(people.some((e) => e.entityId === created.entityId)).toBe(true);

    // resolve() finds the entity by name from the live DB.
    const candidates = await store.resolve({ name: "Alice Example" });
    expect(candidates.some((c) => c.entity.entityId === created.entityId)).toBe(
      true,
    );
  });

  it("relationship observe → list round-trip against the live DB", async () => {
    const entities = service?.getEntityStore();
    const rels = service?.getRelationshipStore();
    if (!entities || !rels) throw new Error("KG stores unavailable");

    const owner = await entities.upsert({
      type: "person",
      preferredName: "Owner Person",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const org = await entities.upsert({
      type: "organization",
      preferredName: "Acme Corp",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    await rels.observe({
      fromEntityId: owner.entityId,
      toEntityId: org.entityId,
      type: "works_at",
      evidence: ["test fixture"],
      confidence: 0.9,
    });

    // list() reads SELECT ... FROM app_lifeops.life_relationships — real read-back.
    const edges = await rels.list({ fromEntityId: owner.entityId });
    expect(
      edges.some((e) => e.toEntityId === org.entityId && e.type === "works_at"),
    ).toBe(true);
  });
});
