/**
 * Proves ENTITY structured-name resolution against the real relationship and
 * interaction stores on PGlite: an ambiguous contact name writes no
 * interaction row, while a unique name writes exactly one row addressed to
 * the named contact. Harness is integration-backed (real graph stores); no
 * model is invoked.
 */
import type { Memory, UUID } from "@elizaos/core";
import { ChannelType, TaskService } from "@elizaos/core";
import { executeSql } from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { contactEdgeId } from "../lifeops/relationships/mapping.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
let ownerId: UUID;
let annSmithId: string;
let annJonesId: string;

interface StoredInteractionRow {
  id: string;
  relationship_id: string;
}

async function readInteractionRows(): Promise<StoredInteractionRow[]> {
  const db = fixture.runtime.adapter.db;
  if (!db) throw new Error("runtime database adapter unavailable");
  const rows = (await executeSql(
    db,
    "SELECT id, relationship_id FROM app_lifeops.life_relationship_interactions ORDER BY created_at ASC, id ASC",
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    relationship_id: String(row.relationship_id),
  }));
}

function ownerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: ownerId,
    agentId: fixture.runtime.agentId,
    roomId,
    content: { text, source: "test" },
  } as Memory;
}

async function runLogInteraction(params: Record<string, unknown>) {
  return (await entityAction.handler(
    fixture.runtime,
    ownerMessage("log this"),
    undefined,
    { parameters: { action: "log_interaction", ...params } },
  )) as {
    success: boolean;
    data?: { error?: string; interaction?: { relationshipId: string } };
  };
}

async function runCreate(params: Record<string, unknown>) {
  return (await entityAction.handler(
    fixture.runtime,
    ownerMessage("add this contact"),
    undefined,
    { parameters: { action: "create", ...params } },
  )) as {
    success: boolean;
    data?: { error?: string; relationship?: { id: string } };
  };
}

beforeAll(async () => {
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  ownerId = service.ownerEntityId() as UUID;
  if (!(await fixture.runtime.getEntityById(ownerId))) {
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Entity name resolution fixture owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Entity name resolution owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Entity name resolution owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );

  const annSmith = await service.relationships.upsertRelationship({
    name: "Ann Smith",
    primaryChannel: "email",
    primaryHandle: "ann.smith@example.test",
    email: "ann.smith@example.test",
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const annJones = await service.relationships.upsertRelationship({
    name: "Ann Jones",
    primaryChannel: "email",
    primaryHandle: "ann.jones@example.test",
    email: "ann.jones@example.test",
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  annSmithId = annSmith.id;
  annJonesId = annJones.id;
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
});

describe("ENTITY log_interaction writes the real interaction row only for one identified contact", () => {
  it("writes no interaction row when a shared name fragment matches two contacts", async () => {
    const result = await runLogInteraction({ name: "ann" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    const rows = await readInteractionRows();
    expect(rows).toEqual([]);
  });

  it("writes exactly one interaction row addressed to the uniquely named contact", async () => {
    const result = await runLogInteraction({ name: "ann smith" });
    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(annSmithId);
    const rows = await readInteractionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship_id).toBe(annSmithId);
  });

  it("writes the row to the other contact when its full name is given", async () => {
    const result = await runLogInteraction({ name: "ann jones" });
    expect(result.success).toBe(true);
    const rows = await readInteractionRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.relationship_id).toBe(annJonesId);
  });
});

describe("ENTITY create fails closed on an ambiguous contact identity", () => {
  it("does not change either person or add an edge", async () => {
    const repo = new LifeOpsRepository(fixture.runtime);
    const entityStore = await repo.entityStore(fixture.runtime.agentId);
    const addedAt = "2026-05-01T10:00:00.000Z";
    for (const [entityId, preferredName] of [
      ["ent-ambiguous-ann", "Ann"],
      ["ent-ambiguous-bob", "Bob"],
    ]) {
      await entityStore.upsert({
        entityId,
        type: "person",
        preferredName,
        identities: [
          {
            platform: "telegram",
            handle: "@shared_handle",
            verified: true,
            confidence: 1,
            addedAt,
            addedVia: "import",
            evidence: ["existing-contact"],
          },
        ],
        tags: ["existing"],
        visibility: "owner_agent_admin",
        state: {},
      });
    }

    const result = await runCreate({
      name: "New Contact",
      channel: "telegram",
      handle: "@shared_handle",
    });

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("LIFEOPS_CONTACT_IDENTITY_CONFLICT");
    expect((await entityStore.get("ent-ambiguous-ann"))?.preferredName).toBe(
      "Ann",
    );
    expect((await entityStore.get("ent-ambiguous-bob"))?.preferredName).toBe(
      "Bob",
    );
    const relationshipStore = await repo.relationshipStore(
      fixture.runtime.agentId,
    );
    expect(
      await relationshipStore.get(contactEdgeId("ent-ambiguous-ann")),
    ).toBeNull();
    expect(
      await relationshipStore.get(contactEdgeId("ent-ambiguous-bob")),
    ).toBeNull();
  });
});
