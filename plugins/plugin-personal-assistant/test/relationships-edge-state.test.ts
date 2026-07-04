/**
 * Regression coverage: a contact edit must not wipe the SELF→contact edge's
 * interaction-recency state. `RelationshipStore.upsert` is a full-replace
 * write, so `upsertRelationship` has to carry the existing edge state forward
 * when the update carries no `lastContactedAt` — otherwise a notes/tags edit
 * (or a re-add through the identity dedup path) resets `lastInteractionAt`
 * and the cadence-overdue check nags about a freshly-contacted person.
 * Real PGLite runtime, no mocks.
 */

import { KnowledgeGraphService, knowledgeGraphSchema } from "@elizaos/agent";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import { contactEdgeId } from "../src/lifeops/relationships/mapping.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";

const AGENT_ID = "lifeops-relationships-edge-state-agent";

/** Registers the knowledge-graph schema + service the contact graph needs. */
const knowledgeGraphPlugin: Plugin = {
  name: "eliza",
  description: "Test-only knowledge-graph schema + service registration.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
};

describe("upsertRelationship — edge interaction state survives contact edits", () => {
  let runtime: AgentRuntime;
  let service: LifeOpsService;
  let repo: LifeOpsRepository;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: AGENT_ID,
      plugins: [knowledgeGraphPlugin],
    });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    service = new LifeOpsService(runtime);
    repo = new LifeOpsRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("keeps lastInteractionAt when the contact is edited without lastContactedAt", async () => {
    const lastContactedAt = "2026-05-01T10:00:00.000Z";
    const created = await service.upsertRelationship({
      name: "Pat",
      primaryChannel: "telegram",
      primaryHandle: "@pat",
      email: null,
      phone: null,
      notes: "old friend",
      tags: [],
      relationshipType: "friend",
      lastContactedAt,
      metadata: {},
    });

    const store = await repo.relationshipStore(runtime.agentId);
    const edgeBefore = await store.get(contactEdgeId(created.id));
    expect(edgeBefore?.state.lastInteractionAt).toBe(lastContactedAt);

    // Edit the contact's notes without re-asserting lastContactedAt — the
    // exact shape the ENTITY action's update/dedup paths produce.
    await service.upsertRelationship({
      id: created.id,
      name: "Pat",
      primaryChannel: "telegram",
      primaryHandle: "@pat",
      email: null,
      phone: null,
      notes: "old friend — met at the conference",
      tags: ["conference"],
      relationshipType: "friend",
      lastContactedAt: null,
      metadata: {},
    });

    const edgeAfter = await store.get(contactEdgeId(created.id));
    expect(edgeAfter?.state.lastInteractionAt).toBe(lastContactedAt);
  });

  it("lets an explicit lastContactedAt overwrite the carried-forward state", async () => {
    const first = "2026-05-01T10:00:00.000Z";
    const second = "2026-06-01T09:00:00.000Z";
    const created = await service.upsertRelationship({
      name: "Sam",
      primaryChannel: "email",
      primaryHandle: "sam@example.com",
      email: "sam@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: first,
      metadata: {},
    });

    await service.upsertRelationship({
      id: created.id,
      name: "Sam",
      primaryChannel: "email",
      primaryHandle: "sam@example.com",
      email: "sam@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: second,
      metadata: {},
    });

    const store = await repo.relationshipStore(runtime.agentId);
    const edge = await store.get(contactEdgeId(created.id));
    expect(edge?.state.lastInteractionAt).toBe(second);
  });
});
