/** Exercises the canonical graph against real single-agent SQLite files, transactions and restart recovery. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import type { Entity, EntityIdentity } from "@elizaos/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LegacyRelationshipsSchemaAuditService } from "../services/legacy-schema-audit.ts";
import { KnowledgeGraphService } from "./service.ts";

const agentId = randomUUID() as UUID;
const time = "2026-09-23T12:00:00.000Z";
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];

async function open(file = "agent.sqlite", owner = agentId) {
  const adapter = SQLiteDatabaseAdapter.create(join(directory, file), owner);
  opened.push(adapter);
  await adapter.initialize();
  const runtime = new AgentRuntime({
    agentId: owner,
    character: { name: "Synthetic graph agent" },
    adapter,
  });
  const service = await KnowledgeGraphService.start(runtime);
  await LegacyRelationshipsSchemaAuditService.start(runtime);
  return {
    adapter,
    runtime,
    service,
    entities: service.getEntityStore(),
    relationships: service.getRelationshipStore(),
  };
}

function entity(
  id: string,
  identities: EntityIdentity[] = [],
): Omit<Entity, "createdAt" | "updatedAt"> {
  return {
    entityId: id,
    type: "person",
    preferredName: id,
    identities,
    state: {},
    tags: [],
    visibility: "owner_only",
  };
}
function identity(
  handle: string,
  connectorAccountId = "default",
): EntityIdentity {
  return {
    platform: "email",
    handle,
    connectorAccountId,
    verified: true,
    confidence: 1,
    addedAt: time,
    addedVia: "user_chat",
    evidence: [`synthetic:${handle}`],
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "canonical-graph-sqlite-"));
});
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

it("preserves full graph records, identity evidence, retirement and audit after native close/reopen", async () => {
  const graph = await open();
  await graph.entities.ensureSelf();
  const evidence = "complete synthetic evidence ".repeat(5000);
  const original = await graph.entities.upsert({
    ...entity("senior", [identity("senior@example.test", "family")]),
    attributes: {
      biography: {
        value: evidence,
        confidence: 1,
        evidence: ["reviewed"],
        updatedAt: time,
      },
    },
    tags: ["family"],
  });
  const edge = await graph.relationships.observe({
    fromEntityId: "self",
    toEntityId: "senior",
    type: "knows",
    evidence: [evidence],
    confidence: 0.8,
    occurredAt: time,
  });
  const updated = await graph.relationships.upsert({
    ...edge,
    metadata: {},
    retiredAt: time,
    retiredReason: "not a retirement operation",
  });
  expect(updated.retiredAt).toBeUndefined();
  expect(updated.retiredReason).toBeUndefined();
  expect(updated.metadata).toBeUndefined();
  await graph.relationships.retire(edge.relationshipId, "synthetic withdrawal");
  const retired = await graph.relationships.get(edge.relationshipId);
  const audit = await graph.relationships.listAuditEvents(edge.relationshipId);
  await graph.adapter.close();
  const reopened = await open();
  expect(await reopened.entities.get("senior")).toEqual(original);
  expect(await reopened.relationships.get(edge.relationshipId)).toEqual(
    retired,
  );
  expect(
    await reopened.relationships.listAuditEvents(edge.relationshipId),
  ).toEqual(audit);
  expect(audit).toMatchObject([
    { kind: "retire", details: { reason: "synthetic withdrawal" } },
  ]);
  expect(await reopened.relationships.list()).toEqual([]);
  expect(
    await reopened.entities.list({
      hasPlatform: "EMAIL",
      hasConnectorAccountId: "family",
      tag: "family",
    }),
  ).toEqual([original]);
});

it("serializes concurrent identity observations and edge strengthening without losing evidence", async () => {
  const { entities, relationships } = await open();
  const observations = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      entities.observeIdentity({
        platform: "email",
        handle: "same@example.test",
        connectorAccountId: "family",
        confidence: 1,
        evidence: [`observation-${i}`],
      }),
    ),
  );
  expect(new Set(observations.map((row) => row.entity.entityId)).size).toBe(1);
  const stored = await entities.list();
  expect(stored).toHaveLength(1);
  expect(stored[0].identities[0].evidence).toHaveLength(12);
  const edges = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      relationships.observe({
        fromEntityId: "self",
        toEntityId: stored[0].entityId,
        type: "knows",
        evidence: [`edge-${i}`],
        confidence: 0.8,
      }),
    ),
  );
  expect(new Set(edges.map((row) => row.relationshipId)).size).toBe(1);
  const [edge] = await relationships.list();
  expect(edge.state.interactionCount).toBe(12);
  expect(edge.evidence).toHaveLength(12);
});

it("merges through the shared engine, retargets both edge ends and rolls back the whole graph on failure", async () => {
  const { adapter, entities, relationships } = await open();
  const target = await entities.upsert(
    entity("target", [identity("target@example.test")]),
  );
  const source = await entities.upsert({
    ...entity("source", [identity("source@example.test")]),
    tags: ["source-tag"],
  });
  const edge = await relationships.observe({
    fromEntityId: "source",
    toEntityId: "source",
    type: "knows",
    evidence: ["kept"],
    confidence: 1,
  });
  await expect(
    adapter.recordStore.transaction(async () => {
      await entities.merge("target", ["source"]);
      await relationships.retire(edge.relationshipId, "rollback");
      throw new Error("synthetic transaction failure");
    }),
  ).rejects.toMatchObject({
    code: "SQLITE_TRANSACTION_FAILED",
    cause: { message: "synthetic transaction failure" },
  });
  expect(await entities.get("target")).toEqual(target);
  expect(await entities.get("source")).toEqual(source);
  expect(await relationships.get(edge.relationshipId)).toEqual(edge);
  expect(await relationships.listAuditEvents(edge.relationshipId)).toEqual([]);
  const merged = await entities.merge("target", ["source"]);
  expect(merged.identities.map((row) => row.handle).sort()).toEqual([
    "source@example.test",
    "target@example.test",
  ]);
  expect(merged.tags).toContain("source-tag");
  expect(await entities.get("source")).toBeNull();
  expect(await relationships.get(edge.relationshipId)).toMatchObject({
    fromEntityId: "target",
    toEntityId: "target",
    evidence: ["kept"],
  });
});

it("denies another agent's graph selection and preserves independent same-ID records", async () => {
  const a = await open();
  const otherId = randomUUID() as UUID;
  const b = await open("other.sqlite", otherId);
  await a.entities.upsert({ ...entity("same"), preferredName: "A" });
  await b.entities.upsert({ ...entity("same"), preferredName: "B" });
  expect(() => a.service.getEntityStore(otherId)).toThrow(/agent-bound/);
  expect(() => a.service.getRelationshipStore(otherId)).toThrow(/agent-bound/);
  expect(await a.entities.get("same")).toMatchObject({ preferredName: "A" });
  expect(await b.entities.get("same")).toMatchObject({ preferredName: "B" });
});

it("confirms a recipient once under concurrency and rejects ambiguity, stale review and conflicting identity", async () => {
  const { entities } = await open();
  const request = {
    entityId: null,
    name: "Synthetic person",
    address: " Person@Example.test ",
    confirmedBy: "synthetic-owner",
  };
  const replies = await Promise.all(
    Array.from({ length: 6 }, () => entities.confirmEmailRecipient(request)),
  );
  expect(new Set(replies.map((row) => row.entityId)).size).toBe(1);
  const [stored] = await entities.list();
  expect(stored.identities).toMatchObject([
    { verified: true, evidence: ["owner-confirmation:synthetic-owner"] },
  ]);
  await expect(
    entities.confirmEmailRecipient({ ...request, name: "Changed name" }),
  ).rejects.toMatchObject({ code: "ENTITY_RECIPIENT_REVIEW_STALE" });
  await entities.upsert(entity("other"));
  await expect(
    entities.confirmEmailRecipient({ ...request, entityId: "other" }),
  ).rejects.toMatchObject({ code: "ENTITY_RECIPIENT_IDENTITY_CONFLICT" });
  await entities.upsert(entity("ambiguous", [identity("person@example.test")]));
  await expect(entities.confirmEmailRecipient(request)).rejects.toMatchObject({
    code: "ENTITY_RECIPIENT_AMBIGUOUS",
  });
  await expect(
    entities.confirmEmailRecipient({ ...request, address: "bad\naddress" }),
  ).rejects.toMatchObject({ code: "ENTITY_RECIPIENT_INVALID" });
});

it("returns the complete graph unless a caller requests pagination and refuses unsupported schema versions", async () => {
  const { entities, adapter, runtime } = await open();
  for (let i = 0; i < 125; i++)
    await entities.upsert(entity(`person-${String(i).padStart(3, "0")}`));
  expect(await entities.list()).toHaveLength(125);
  expect(await entities.list({ limit: 2 })).toHaveLength(2);
  expect(await entities.list({ limit: 0 })).toEqual([]);
  await expect(entities.list({ limit: -1 })).rejects.toMatchObject({
    code: "KNOWLEDGE_GRAPH_RECORD_STORE_INVALID",
  });
  await adapter.recordStore.set("plugin_knowledge_graph_schema", "version", 2);
  await expect(KnowledgeGraphService.start(runtime)).rejects.toMatchObject({
    code: "KNOWLEDGE_GRAPH_RECORD_STORE_INVALID",
  });
  await expect(entities.list()).rejects.toMatchObject({
    code: "KNOWLEDGE_GRAPH_RECORD_STORE_INVALID",
  });
});
