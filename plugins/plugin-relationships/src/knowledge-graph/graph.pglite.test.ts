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

it("keeps the latest contact time and platform when an older interaction arrives late or overlaps on PostgreSQL", async () => {
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
  const interaction = (platform: string, occurredAt: string) => ({
    platform,
    direction: "inbound" as const,
    summary: "synthetic",
    occurredAt,
  });
  const observe = (occurredAt: string) =>
    relationships.observe({
      fromEntityId: "self",
      toEntityId: "late-contact",
      type: "knows",
      confidence: 1,
      evidence: [`synthetic:${occurredAt}`],
      occurredAt,
    });
  const newer = "2026-10-10T12:00:00.000Z";
  const older = "2026-09-20T12:00:00.000Z";

  await entities.recordInteraction(
    "late-contact",
    interaction("discord", newer),
  );
  await observe(newer);
  await entities.recordInteraction(
    "late-contact",
    interaction("telegram", older),
  );
  expect(await observe(older)).toMatchObject({
    state: {
      lastObservedAt: newer,
      lastInteractionAt: newer,
      interactionCount: 2,
    },
  });
  expect((await entities.get("late-contact"))?.state).toMatchObject({
    lastInboundAt: newer,
    lastObservedAt: newer,
    lastInteractionPlatform: "discord",
  });

  // The SQL path has no lock, so overlapping writes must also keep the newer one.
  const newest = "2026-10-12T12:00:00.000Z";
  await Promise.all([
    entities.recordInteraction("late-contact", interaction("signal", newest)),
    entities.recordInteraction("late-contact", interaction("telegram", older)),
    entities.recordInteraction("late-contact", interaction("telegram", newer)),
  ]);
  expect((await entities.get("late-contact"))?.state).toMatchObject({
    lastInboundAt: newest,
    lastObservedAt: newest,
    lastInteractionPlatform: "signal",
  });

  // An older outbound sets its own direction and leaves overall recency alone.
  await entities.recordInteraction("late-contact", {
    ...interaction("telegram", older),
    direction: "outbound",
  });
  expect((await entities.get("late-contact"))?.state).toMatchObject({
    lastInboundAt: newest,
    lastOutboundAt: older,
    lastObservedAt: newest,
    lastInteractionPlatform: "signal",
  });
});
