/** Exercises the unchanged PostgreSQL graph path using real PGlite migrations and the canonical stores. */
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
