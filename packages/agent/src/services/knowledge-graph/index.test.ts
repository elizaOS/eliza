/**
 * Public-entry coverage for the runtime knowledge-graph barrel. Drives the
 * exported stores, service, and schema against a real in-memory PGlite
 * database (real SQL execution, no mocked echo) so the suite proves the
 * assembled surface consumers import actually persists and queries graphs.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntityStore as DeepEntityStore } from "./entity-store.ts";
import {
  EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  knowledgeGraphSchema,
  RelationshipStore,
  resolveKnowledgeGraphService,
} from "./index.ts";
import { RelationshipStore as DeepRelationshipStore } from "./relationship-store.ts";
import { knowledgeGraphSchema as DeepSchema } from "./schema.ts";
import {
  KnowledgeGraphService as DeepService,
  resolveKnowledgeGraphService as deepResolve,
} from "./service.ts";

const AGENT_A = "agent-a";

let pglite: PGlite;
let runtime: IAgentRuntime;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(`
    CREATE SCHEMA app_lifeops;
    CREATE TABLE app_lifeops.life_entities (
      entity_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      preferred_name TEXT NOT NULL,
      full_name TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      visibility TEXT NOT NULL DEFAULT 'owner_agent_admin',
      state_last_observed_at TEXT,
      state_last_inbound_at TEXT,
      state_last_outbound_at TEXT,
      state_last_interaction_platform TEXT,
      legacy_relationship_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, entity_id)
    );
    CREATE TABLE app_lifeops.life_entity_identities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      connector_account_id TEXT NOT NULL DEFAULT 'default',
      display_name TEXT,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      confidence REAL NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      added_via TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (agent_id, entity_id, platform, connector_account_id, handle)
    );
    CREATE TABLE app_lifeops.life_entity_attributes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL DEFAULT 'null',
      confidence REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, entity_id, key)
    );
    CREATE TABLE app_lifeops.life_relationships_v2 (
      relationship_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      cadence_days INTEGER,
      state_last_observed_at TEXT,
      state_last_interaction_at TEXT,
      state_interaction_count INTEGER NOT NULL DEFAULT 0,
      state_sentiment_trend TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      retired_at TEXT,
      retired_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_lifeops.life_relationship_audit_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      relationship_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  runtime = {
    agentId: AGENT_A,
    adapter: { db: drizzle(pglite) },
  } as unknown as IAgentRuntime;
});

afterAll(async () => {
  await pglite.close();
});

afterEach(async () => {
  await pglite.exec(`
    TRUNCATE app_lifeops.life_entities,
             app_lifeops.life_entity_identities,
             app_lifeops.life_entity_attributes,
             app_lifeops.life_relationships_v2,
             app_lifeops.life_relationship_audit_events;
  `);
});

describe("knowledge-graph public entry", () => {
  it("re-exports live bindings rather than copies", () => {
    expect(EntityStore).toBe(DeepEntityStore);
    expect(RelationshipStore).toBe(DeepRelationshipStore);
    expect(KnowledgeGraphService).toBe(DeepService);
    expect(knowledgeGraphSchema).toBe(DeepSchema);
    expect(resolveKnowledgeGraphService).toBe(deepResolve);
    expect(KNOWLEDGE_GRAPH_SERVICE).toBe("eliza_knowledge_graph");
  });

  it("boots a service whose factories produce the exported stores", async () => {
    const svc = await KnowledgeGraphService.start(runtime);
    const probed = {
      getService: () => svc,
    } as unknown as IAgentRuntime;
    expect(resolveKnowledgeGraphService(probed)).toBe(svc);
    expect(svc.getEntityStore()).toBeInstanceOf(EntityStore);
    expect(svc.getRelationshipStore("other-agent")).toBeInstanceOf(
      RelationshipStore,
    );
  });

  it("roundtrips entities with identities, attributes, and tags", async () => {
    const store = new EntityStore(runtime, AGENT_A);

    const self = await store.ensureSelf();
    expect(self.entityId).toBe("self");
    expect(self.type).toBe("person");
    expect(self.visibility).toBe("owner_only");
    const selfAgain = await store.ensureSelf();
    expect(selfAgain.createdAt).toBe(self.createdAt);

    const alice = await store.upsert({
      entityId: "ent_alice",
      type: "person",
      preferredName: "Alice",
      fullName: "Alice Doe",
      identities: [
        {
          platform: "telegram",
          handle: "@alice",
          connectorAccountId: "conn-1",
          verified: true,
          confidence: 0.9,
          addedAt: self.createdAt,
          addedVia: "platform_observation",
          evidence: ["introduced by owner"],
        },
      ],
      attributes: {
        city: {
          value: "Tokyo",
          confidence: 0.8,
          evidence: ["profile"],
          updatedAt: self.createdAt,
        },
      },
      tags: ["friend"],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(alice.entityId).toBe("ent_alice");
    expect(alice.fullName).toBe("Alice Doe");
    expect(alice.identities).toHaveLength(1);
    expect(alice.identities[0]?.handle).toBe("@alice");
    expect(alice.identities[0]?.verified).toBe(true);
    expect(alice.attributes?.city?.value).toBe("Tokyo");
    expect(alice.tags).toEqual(["friend"]);

    const updated = await store.upsert({
      entityId: "ent_alice",
      type: "person",
      preferredName: "Alice D.",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(updated.preferredName).toBe("Alice D.");
    expect(updated.createdAt).toBe(alice.createdAt);
    expect(updated.identities).toHaveLength(0);
    expect(updated.attributes?.city).toBeUndefined();

    const all = await store.list();
    expect(all.map((entity) => entity.entityId).sort()).toEqual([
      "ent_alice",
      "self",
    ]);
  });

  it("partitions the graph per agentId", async () => {
    const forA = new EntityStore(runtime, AGENT_A);
    const forB = new EntityStore(runtime, "agent-b");

    await forA.upsert({
      entityId: "ent_shared_name",
      type: "project",
      preferredName: "A-side project",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    expect(await forB.get("ent_shared_name")).toBeNull();

    await forB.upsert({
      entityId: "ent_shared_name",
      type: "project",
      preferredName: "B-side project",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const aRow = await forA.get("ent_shared_name");
    const bRow = await forB.get("ent_shared_name");
    expect(aRow?.preferredName).toBe("A-side project");
    expect(bRow?.preferredName).toBe("B-side project");
    expect(await forA.list()).toHaveLength(1);
    expect(await forB.list()).toHaveLength(1);
  });

  it("strengthens repeated observations into one edge and retires softly", async () => {
    const edges = new RelationshipStore(runtime, AGENT_A);

    const first = await edges.observe({
      fromEntityId: "self",
      toEntityId: "ent_alice",
      type: "knows",
      evidence: ["chat-1"],
      confidence: 0.5,
      source: "extraction",
    });
    expect(first.status).toBe("active");
    expect(first.state.interactionCount).toBe(1);
    expect(first.evidence).toEqual(["chat-1"]);

    const second = await edges.observe({
      fromEntityId: "self",
      toEntityId: "ent_alice",
      type: "knows",
      metadataPatch: { cadenceDays: 14 },
      evidence: ["chat-2"],
      confidence: 0.7,
      source: "extraction",
    });
    expect(second.relationshipId).toBe(first.relationshipId);
    expect(second.state.interactionCount).toBe(2);
    expect(second.confidence).toBe(0.7);
    expect(second.evidence.sort()).toEqual(["chat-1", "chat-2"]);
    expect(second.metadata?.cadenceDays).toBe(14);
    expect(await edges.list()).toHaveLength(1);

    await edges.retire(first.relationshipId, "superseded");
    expect(await edges.list()).toHaveLength(0);

    const retiredView = await edges.list({ includeRetired: true });
    expect(retiredView).toHaveLength(1);
    expect(retiredView[0]?.status).toBe("retired");
    expect(retiredView[0]?.retiredReason).toBe("superseded");

    const onRetired = await edges.observe({
      fromEntityId: "self",
      toEntityId: "ent_alice",
      type: "knows",
      evidence: ["chat-3"],
      confidence: 0.9,
      source: "extraction",
    });
    expect(onRetired.status).toBe("retired");
    expect(onRetired.relationshipId).toBe(first.relationshipId);
    expect(await edges.list({ includeRetired: true })).toHaveLength(1);

    const audits = await edges.listAuditEvents(first.relationshipId);
    const kinds = audits.map((event) => event.kind);
    expect(kinds).toContain("retire");
    expect(kinds).toContain("observe_on_retired");
  });

  it("exposes schema tables that read back rows the raw-SQL stores wrote", async () => {
    const store = new EntityStore(runtime, AGENT_A);
    await store.upsert({
      entityId: "ent_bridge",
      type: "place",
      preferredName: "Kiyosumi Garden",
      identities: [],
      tags: ["park"],
      visibility: "owner_agent_admin",
      state: { lastObservedAt: "2026-08-24T00:00:00.000Z" },
    });

    const viaDrizzle = await drizzle(pglite)
      .select()
      .from(knowledgeGraphSchema.lifeEntities);
    expect(viaDrizzle).toHaveLength(1);
    expect(viaDrizzle[0]?.entityId).toBe("ent_bridge");
    expect(viaDrizzle[0]?.tagsJson).toBe('["park"]');
  });
});
