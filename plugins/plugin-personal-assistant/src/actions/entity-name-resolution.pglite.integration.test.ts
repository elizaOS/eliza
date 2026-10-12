/**
 * ENTITY name-based contact resolution against the real PGlite-backed
 * relationship and interaction stores: a name that several contacts share
 * writes nothing, while a single-match fragment produces exactly one durable
 * row in `app_lifeops.life_relationship_interactions`.
 */
import {
  ChannelType,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeRawSql } from "../lifeops/sql.js";
import { entityAction } from "./entity.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
let bobbyId = "";

beforeAll(async () => {
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  const ownerId = service.ownerEntityId() as UUID;
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

  // Two contacts sharing one exact display name: no resolver stage may pick
  // between them by list order.
  await service.upsertRelationship({
    name: "Ann",
    primaryChannel: "email",
    primaryHandle: "ann.a@example.test",
    email: "ann.a@example.test",
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  await service.upsertRelationship({
    name: "Ann",
    primaryChannel: "email",
    primaryHandle: "ann.b@example.test",
    email: "ann.b@example.test",
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const bobby = await service.upsertRelationship({
    name: "Bobby",
    primaryChannel: "email",
    primaryHandle: "bobby@example.test",
    email: "bobby@example.test",
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  bobbyId = bobby.id;
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

async function interactionRows(): Promise<Array<{ relationship_id: string }>> {
  const rows = await executeRawSql(
    fixture.runtime,
    "SELECT relationship_id FROM app_lifeops.life_relationship_interactions ORDER BY created_at ASC, id ASC",
  );
  return rows as Array<{ relationship_id: string }>;
}

async function logInteractionForName(name: string): Promise<{
  success: boolean;
  data?: { error?: string; interaction?: { relationshipId: string } };
}> {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: {
      text: `log the interaction with ${name}`,
      source: "client_chat",
    },
  } as Memory;
  return (await entityAction.handler(fixture.runtime, message, undefined, {
    parameters: { action: "log_interaction", name },
  })) as {
    success: boolean;
    data?: { error?: string; interaction?: { relationshipId: string } };
  };
}

describe("ENTITY name resolution writes real interaction rows", () => {
  it("writes no row when the requested name matches several contacts exactly", async () => {
    const result = await logInteractionForName("ann");

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    expect(await interactionRows()).toEqual([]);
  });

  it("writes exactly one durable row for the single-match fragment", async () => {
    const result = await logInteractionForName("bobby");

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(bobbyId);
    expect(await interactionRows()).toEqual([{ relationship_id: bobbyId }]);
  });
});
