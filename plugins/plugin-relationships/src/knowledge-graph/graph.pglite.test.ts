/** Exercises the PostgreSQL graph path using real PGlite migrations and the canonical stores. */
import { randomUUID } from "node:crypto";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LegacyRelationshipsSchemaAuditService } from "../services/legacy-schema-audit.ts";
import { knowledgeGraphSchema } from "./schema.ts";
import { KnowledgeGraphService } from "./service.ts";

const agentId = randomUUID() as UUID;
const adapter = createDatabaseAdapter({ dataDir: "memory://" }, agentId);
const runtime = new AgentRuntime({
  agentId,
  character: { name: "Synthetic PostgreSQL graph" },
  adapter,
});
let graph: KnowledgeGraphService;

beforeAll(async () => {
  await adapter.initialize();
  if (!adapter.runPluginMigrations)
    throw new Error("The PostgreSQL graph harness requires plugin migrations");
  await adapter.runPluginMigrations([
    { name: "canonical-graph-test", schema: knowledgeGraphSchema },
  ]);
  graph = await KnowledgeGraphService.start(runtime);
  await LegacyRelationshipsSchemaAuditService.start(runtime);
}, 120_000);
afterAll(async () => {
  await adapter.close();
});

it("preserves entity merge, edge retargeting, retirement and audit through real PostgreSQL SQL", async () => {
  const entities = graph.getEntityStore();
  const relationships = graph.getRelationshipStore();
  await entities.ensureSelf();
  const input = {
    type: "person",
    identities: [],
    tags: [],
    visibility: "owner_only" as const,
    state: {},
  };
  await entities.upsert({
    ...input,
    entityId: "target",
    preferredName: "Target",
  });
  await entities.upsert({
    ...input,
    entityId: "source",
    preferredName: "Source",
    tags: ["preserved"],
  });
  const edge = await relationships.observe({
    fromEntityId: "self",
    toEntityId: "source",
    type: "knows",
    confidence: 1,
    evidence: ["synthetic"],
  });
  const merged = await entities.merge("target", ["source"]);
  expect(merged.tags).toContain("preserved");
  expect(await entities.get("source")).toBeNull();
  expect(await relationships.get(edge.relationshipId)).toMatchObject({
    toEntityId: "target",
  });
  await relationships.retire(edge.relationshipId, "synthetic withdrawal");
  expect(await relationships.list()).toEqual([]);
  expect(
    await relationships.listAuditEvents(edge.relationshipId),
  ).toMatchObject([
    { kind: "retire", details: { reason: "synthetic withdrawal" } },
  ]);
});

it("retains current-recipient review and identity evidence on the PostgreSQL confirmation path", async () => {
  const entities = graph.getEntityStore();
  const request = {
    entityId: null,
    name: "Synthetic recipient",
    address: "synthetic@example.test",
    confirmedBy: "synthetic-owner",
  };
  const first = await entities.confirmEmailRecipient(request);
  expect(await entities.confirmEmailRecipient(request)).toEqual(first);
  expect(await entities.get(first.entityId)).toMatchObject({
    identities: [
      { verified: true, evidence: ["owner-confirmation:synthetic-owner"] },
    ],
  });
  await expect(
    entities.confirmEmailRecipient({ ...request, name: "Stale name" }),
  ).rejects.toMatchObject({ code: "ENTITY_RECIPIENT_REVIEW_STALE" });
  expect(
    await graph.getEntityStore(randomUUID()).get(first.entityId),
  ).toBeNull();
});
it("keeps the newest interaction time and platform when an older one is recorded late", async () => {
  const entities = graph.getEntityStore();
  const relationships = graph.getRelationshipStore();
  await entities.ensureSelf();
  await entities.upsert({
    entityId: "late-contact",
    type: "person",
    preferredName: "Late contact",
    identities: [],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
  const record = (platform: string, occurredAt: string) =>
    entities.recordInteraction("late-contact", {
      platform,
      direction: "inbound",
      summary: "synthetic",
      occurredAt,
    });
  const observe = (occurredAt: string) =>
    relationships.observe({
      fromEntityId: "self",
      toEntityId: "late-contact",
      type: "knows",
      confidence: 1,
      evidence: [occurredAt],
      occurredAt,
    });
  await record("discord", "2026-10-10T12:00:00.000Z");
  await record("telegram", "2026-09-20T12:00:00.000Z");
  await observe("2026-10-10T12:00:00.000Z");
  const edge = await observe("2026-09-20T12:00:00.000Z");
  expect((await entities.get("late-contact"))?.state).toEqual({
    lastObservedAt: "2026-10-10T12:00:00.000Z",
    lastInboundAt: "2026-10-10T12:00:00.000Z",
    lastInteractionPlatform: "discord",
  });
  expect(edge.state).toMatchObject({
    lastObservedAt: "2026-10-10T12:00:00.000Z",
    lastInteractionAt: "2026-10-10T12:00:00.000Z",
    interactionCount: 2,
  });
  await record("telegram", "2026-10-11T12:00:00.000Z");
  expect((await entities.get("late-contact"))?.state).toEqual({
    lastObservedAt: "2026-10-11T12:00:00.000Z",
    lastInboundAt: "2026-10-11T12:00:00.000Z",
    lastInteractionPlatform: "telegram",
  });
});
