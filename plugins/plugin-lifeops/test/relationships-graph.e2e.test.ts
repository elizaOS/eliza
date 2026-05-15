/**
 * Tests for the RelationshipStore + extraction helpers.
 *
 * Covers:
 *   - multi-type edges between same pair (Pat is colleague_of AND knows
 *     with separate cadences)
 *   - RelationshipStore.observe strengthening (adds evidence, bumps
 *     interactionCount, updates lastInteractionAt)
 *   - retire-with-audit (soft-delete; new evidence does NOT revive)
 *   - extraction.ts: "Pat is my manager at Acme" → 2 entities + 3 edges
 *   - cadenceOverdueAsOf filter
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { EntityStore } from "../src/lifeops/entities/store";
import { SELF_ENTITY_ID } from "../src/lifeops/entities/types";
import {
  applyExtractedEdges,
  managerOfAtCompany,
} from "../src/lifeops/relationships/extraction";
import { RelationshipStore } from "../src/lifeops/relationships/store";
import { LifeOpsRepository } from "../src/lifeops/repository";

describe("RelationshipStore — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let entityStore: EntityStore;
  let store: RelationshipStore;
  const agentId = "relationship-graph-tests";

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: agentId });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    entityStore = new EntityStore(runtime, agentId);
    store = new RelationshipStore(runtime, agentId);
    await entityStore.ensureSelf();
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("upsert creates an edge and list returns it", async () => {
    const pat = await entityStore.upsert({
      type: "person",
      preferredName: "Pat",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const rel = await store.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: pat.entityId,
      type: "colleague_of",
      metadata: { cadenceDays: 14 },
      state: {},
      evidence: ["seed"],
      confidence: 0.9,
      source: "user_chat",
    });
    const list = await store.list({ fromEntityId: SELF_ENTITY_ID });
    expect(
      list.find((r) => r.relationshipId === rel.relationshipId),
    ).toBeTruthy();
  });

  it("supports multiple typed edges between the same pair (colleague_of + knows)", async () => {
    const taylor = await entityStore.upsert({
      type: "person",
      preferredName: "Taylor",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const colleague = await store.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: taylor.entityId,
      type: "colleague_of",
      metadata: { cadenceDays: 14 },
      state: {},
      evidence: ["c"],
      confidence: 0.9,
      source: "user_chat",
    });
    const friend = await store.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: taylor.entityId,
      type: "knows",
      metadata: { cadenceDays: 30 },
      state: {},
      evidence: ["k"],
      confidence: 0.85,
      source: "user_chat",
    });
    const edges = await store.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: taylor.entityId,
    });
    expect(edges.map((e) => e.type).sort()).toEqual(["colleague_of", "knows"]);
    expect(colleague.relationshipId).not.toBe(friend.relationshipId);
  });

  it("observe strengthens an existing matching edge", async () => {
    const sam = await entityStore.upsert({
      type: "person",
      preferredName: "Sam",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const a = await store.observe({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: sam.entityId,
      type: "knows",
      evidence: ["sam-1"],
      confidence: 0.6,
    });
    const b = await store.observe({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: sam.entityId,
      type: "knows",
      evidence: ["sam-2"],
      confidence: 0.7,
    });
    expect(a.relationshipId).toBe(b.relationshipId);
    expect(b.evidence).toContain("sam-1");
    expect(b.evidence).toContain("sam-2");
    expect(b.confidence).toBeCloseTo(0.7);
    expect(b.state.interactionCount).toBe(2);
  });

  it("retire soft-deletes; observe-on-retired logs evidence without reviving", async () => {
    const ex = await entityStore.upsert({
      type: "person",
      preferredName: "ExColleague",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const rel = await store.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: ex.entityId,
      type: "colleague_of",
      metadata: {},
      state: {},
      evidence: [],
      confidence: 0.9,
      source: "user_chat",
    });
    await store.retire(rel.relationshipId, "left_company");
    // Default list excludes retired.
    const active = await store.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: ex.entityId,
    });
    expect(
      active.find((r) => r.relationshipId === rel.relationshipId),
    ).toBeFalsy();

    // observe-on-retired logs but does not revive.
    const after = await store.observe({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: ex.entityId,
      type: "colleague_of",
      evidence: ["resurrection-attempt"],
      confidence: 0.95,
    });
    expect(after.status).toBe("retired");

    const all = await store.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: ex.entityId,
      includeRetired: true,
    });
    const retired = all.find((r) => r.relationshipId === rel.relationshipId);
    expect(retired?.status).toBe("retired");

    const audit = await store.listAuditEvents(rel.relationshipId);
    expect(audit.find((event) => event.kind === "retire")).toBeTruthy();
    expect(
      audit.find((event) => event.kind === "observe_on_retired"),
    ).toBeTruthy();
  });

  it("cadenceOverdueAsOf returns edges past their cadenceDays threshold", async () => {
    const friend = await entityStore.upsert({
      type: "person",
      preferredName: "OverdueFriend",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await store.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: friend.entityId,
      type: "follows",
      metadata: { cadenceDays: 3 },
      state: { lastInteractionAt: sevenDaysAgo },
      evidence: [],
      confidence: 0.9,
      source: "user_chat",
    });
    const overdue = await store.list({
      cadenceOverdueAsOf: new Date().toISOString(),
    });
    expect(
      overdue.find((rel) => rel.toEntityId === friend.entityId),
    ).toBeTruthy();
  });

  it("extraction: 'Pat is my manager at Acme' produces 2 entities + 3 edges", async () => {
    const result = await applyExtractedEdges({
      entityStore,
      relationshipStore: store,
      evidenceId: "utterance-pat-acme",
      edges: managerOfAtCompany("PatExtract", "AcmeExtract"),
    });
    expect(result.entities.length).toBeGreaterThanOrEqual(3); // self + Pat + Acme
    const pat = result.entities.find((e) => e.preferredName === "PatExtract");
    const acme = result.entities.find((e) => e.preferredName === "AcmeExtract");
    expect(pat).toBeTruthy();
    expect(acme).toBeTruthy();
    expect(acme?.type).toBe("organization");

    expect(result.relationships).toHaveLength(3);
    const types = result.relationships.map((r) => r.type).sort();
    expect(types).toEqual(["managed_by", "works_at", "works_at"]);

    const selfManagedBy = result.relationships.find(
      (r) => r.fromEntityId === SELF_ENTITY_ID && r.type === "managed_by",
    );
    expect(selfManagedBy?.toEntityId).toBe(pat?.entityId);

    const selfWorksAt = result.relationships.find(
      (r) =>
        r.fromEntityId === SELF_ENTITY_ID &&
        r.type === "works_at" &&
        r.toEntityId === acme?.entityId,
    );
    expect(selfWorksAt).toBeTruthy();

    const patWorksAt = result.relationships.find(
      (r) =>
        r.fromEntityId === pat?.entityId &&
        r.type === "works_at" &&
        r.toEntityId === acme?.entityId,
    );
    expect(patWorksAt).toBeTruthy();
  });
});
