/**
 * Real-PGlite DB round-trip test for the relationships data path.
 *
 * plugin-relationships is a VIEWER + KNOWLEDGE_GRAPH action over the runtime's
 * KnowledgeGraphService (owned by @elizaos/agent) — that service's
 * EntityStore / RelationshipStore are the relationships domain's real backing.
 * This boots a REAL PGLite-backed AgentRuntime, registers the KG service + its
 * schema, and round-trips entities + a relationship through the SAME stores the
 * relationships action drives — write → read back from the live
 * `app_lifeops.life_entities` / `life_relationships` tables (EntityStore.get /
 * .list / .resolve issue real SELECTs). No mocked adapter.
 */

import {
  KnowledgeGraphService,
  knowledgeGraphSchema,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";

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
      plugins: [kgPlugin],
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
