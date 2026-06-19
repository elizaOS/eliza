/**
 * Real-DB integration test for the runtime KnowledgeGraphService.
 *
 * `relationships-graph.e2e.test.ts` (sibling file) already covers the
 * EntityStore.upsert + RelationshipStore (upsert / observe / retire / cadence)
 * surface directly on real PGLite, so this file does NOT duplicate that. It
 * covers the runtime-service layer the production agent uses instead of
 * constructing the stores by hand:
 *
 *   - `resolveKnowledgeGraphService` returns the registered service.
 *   - `service.getEntityStore(...)` round-trips upsert → get against the DB.
 *   - `EntityStore.observeIdentity` (create + same-handle fold) — not covered
 *     by the relationships test.
 *   - `EntityStore.merge` folds a source entity into a target and rewrites the
 *     relationship edges that pointed at the source.
 *   - `service.getRelationshipStore(...)` upserts an edge and lists it back.
 *
 * The service is registered by the "eliza" plugin in production; here we
 * register a minimal test plugin carrying `knowledgeGraphSchema` (so the
 * app_lifeops graph tables migrate) + `KnowledgeGraphService`, then drive the
 * real PGLite-backed runtime.
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
import { SELF_ENTITY_ID } from "../src/lifeops/entities/types";

/**
 * Minimal stand-in for the production "eliza" plugin: registers the
 * knowledge-graph schema (creates the app_lifeops graph tables on init) and the
 * KnowledgeGraphService so `resolveKnowledgeGraphService` finds it.
 */
const knowledgeGraphPlugin: Plugin = {
  name: "eliza",
  description: "Test-only knowledge-graph schema + service registration.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
};

describe("KnowledgeGraphService — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  const agentScope = "knowledge-graph-service-tests";

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: agentScope,
      plugins: [knowledgeGraphPlugin],
    });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("resolves the registered service from the runtime", () => {
    const service = resolveKnowledgeGraphService(runtime);
    expect(service).toBeInstanceOf(KnowledgeGraphService);
  });

  it("upserts an entity through the service store and reads it back", async () => {
    const service = resolveKnowledgeGraphService(runtime);
    expect(service).not.toBeNull();
    const entityStore = service?.getEntityStore(agentScope);
    expect(entityStore).toBeTruthy();
    if (!entityStore) return;

    await entityStore.ensureSelf();
    const pat = await entityStore.upsert({
      type: "person",
      preferredName: "Pat",
      identities: [],
      tags: ["colleague"],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(pat.entityId).toBeTruthy();

    const fetched = await entityStore.get(pat.entityId);
    expect(fetched?.preferredName).toBe("Pat");
    expect(fetched?.tags).toContain("colleague");
  });

  it("observeIdentity creates an entity then folds a same-handle observation", async () => {
    const service = resolveKnowledgeGraphService(runtime);
    const entityStore = service?.getEntityStore(agentScope);
    if (!entityStore) throw new Error("entity store unavailable");

    const created = await entityStore.observeIdentity({
      platform: "discord",
      handle: "robin#1234",
      displayName: "Robin",
      evidence: ["seen in #general"],
      confidence: 0.9,
    });
    expect(created.entity.entityId).toBeTruthy();
    expect(created.mergedFrom).toBeUndefined();
    expect(
      created.entity.identities.some((i) => i.handle === "robin#1234"),
    ).toBe(true);

    // Re-observing the same platform+handle folds onto the same entity.
    const second = await entityStore.observeIdentity({
      platform: "discord",
      handle: "robin#1234",
      displayName: "Robin",
      evidence: ["seen again"],
      confidence: 0.95,
    });
    expect(second.entity.entityId).toBe(created.entity.entityId);
    expect(second.mergedFrom).toEqual([created.entity.entityId]);
  });

  it("merge folds a source entity into a target and rewrites its edges", async () => {
    const service = resolveKnowledgeGraphService(runtime);
    if (!service) throw new Error("service unavailable");
    const entityStore = service.getEntityStore(agentScope);
    const relationshipStore = service.getRelationshipStore(agentScope);
    await entityStore.ensureSelf();

    const target = await entityStore.upsert({
      type: "person",
      preferredName: "Alex (canonical)",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const duplicate = await entityStore.upsert({
      type: "person",
      preferredName: "Alex (dupe)",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    // An edge points at the duplicate; merge must rewrite it to the target.
    const edge = await relationshipStore.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: duplicate.entityId,
      type: "knows",
      metadata: {},
      state: {},
      evidence: ["pre-merge"],
      confidence: 0.8,
      source: "user_chat",
    });

    const merged = await service
      .getEntityStore(agentScope)
      .merge(target.entityId, [duplicate.entityId]);
    expect(merged.entityId).toBe(target.entityId);

    // The duplicate row is gone.
    expect(await entityStore.get(duplicate.entityId)).toBeNull();

    // The edge now points at the target (rewritten during merge).
    const edges = await relationshipStore.list({
      fromEntityId: SELF_ENTITY_ID,
    });
    const rewritten = edges.find(
      (e) => e.relationshipId === edge.relationshipId,
    );
    expect(rewritten?.toEntityId).toBe(target.entityId);
  });

  it("getRelationshipStore upserts an edge and lists it back", async () => {
    const service = resolveKnowledgeGraphService(runtime);
    if (!service) throw new Error("service unavailable");
    const entityStore = service.getEntityStore(agentScope);
    const relationshipStore = service.getRelationshipStore(agentScope);
    await entityStore.ensureSelf();

    const sam = await entityStore.upsert({
      type: "person",
      preferredName: "Sam",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const rel = await relationshipStore.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: sam.entityId,
      type: "colleague_of",
      metadata: { cadenceDays: 14 },
      state: {},
      evidence: ["seed"],
      confidence: 0.9,
      source: "user_chat",
    });

    const edges = await relationshipStore.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: sam.entityId,
    });
    expect(
      edges.find((e) => e.relationshipId === rel.relationshipId),
    ).toBeTruthy();
  });
});
