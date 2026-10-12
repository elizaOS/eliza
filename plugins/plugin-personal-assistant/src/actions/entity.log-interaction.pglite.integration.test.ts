/**
 * ENTITY log_interaction against the real PGlite-backed relationship and
 * interaction stores: resolved contacts produce one durable row in
 * `app_lifeops.life_relationship_interactions`, while ambiguous or
 * substring-only text produces none.
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
let bobId = "";
let bobJonesId = "";
let tanakaId = "";
let sakuraId = "";
let kimId = "";
let zhangSanId = "";

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
      names: ["Entity interaction fixture owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Entity interaction owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Entity interaction owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );

  const bob = await service.upsertRelationship({
    name: "Bob",
    primaryChannel: "imessage",
    primaryHandle: "bob@example.com",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const bobJones = await service.upsertRelationship({
    name: "Bob Jones",
    primaryChannel: "imessage",
    primaryHandle: "bob.jones@example.com",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const tanaka = await service.upsertRelationship({
    name: "田中",
    primaryChannel: "sms",
    primaryHandle: "+819012345678",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const sakura = await service.upsertRelationship({
    name: "さくら",
    primaryChannel: "sms",
    primaryHandle: "+819012345680",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const kim = await service.upsertRelationship({
    name: "김철수",
    primaryChannel: "sms",
    primaryHandle: "+821012345678",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const zhangSan = await service.upsertRelationship({
    name: "张三",
    primaryChannel: "sms",
    primaryHandle: "+8613800138000",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  bobId = bob.id;
  bobJonesId = bobJones.id;
  tanakaId = tanaka.id;
  sakuraId = sakura.id;
  kimId = kim.id;
  zhangSanId = zhangSan.id;
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

async function logInteractionFor(text: string): Promise<{
  success: boolean;
  data?: { error?: string; interaction?: { relationshipId: string } };
}> {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: { text, source: "client_chat" },
  } as Memory;
  const result = (await entityAction.handler(
    fixture.runtime,
    message,
    undefined,
    { parameters: { action: "log_interaction" } },
  )) as {
    success: boolean;
    data?: { error?: string; interaction?: { relationshipId: string } };
  };
  return result;
}

describe("ENTITY log_interaction writes real interaction rows", () => {
  it("writes one durable row for the fully named contact", async () => {
    const result = await logInteractionFor(
      "bob jones picked up the documents today",
    );

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(bobJonesId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship_id).toBe(bobJonesId);
  });

  it("writes no row when the text names two contacts separately", async () => {
    const result = await logInteractionFor(
      "Bob and Bob Jones reviewed the documents together",
    );

    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    const rows = await interactionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship_id).toBe(bobJonesId);
  });

  it("writes no row for an unspaced-script name inside another name", async () => {
    const result = await logInteractionFor(
      "山田中村さんとの打ち合わせをログに残して",
    );

    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    const rows = await interactionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship_id).toBe(bobJonesId);
  });

  it("writes a durable row for an unspaced-script name with attached particles", async () => {
    const result = await logInteractionFor(
      "田中さんとの打ち合わせをログに残して",
    );

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(tanakaId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.relationship_id).toBe(tanakaId);
  });
  it("writes a durable row when only the shorter contact name is given", async () => {
    const result = await logInteractionFor("had a quick call with Bob today");

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(bobId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(3);
    expect(rows[2]?.relationship_id).toBe(bobId);
  });

  it("writes a durable row for a kana name with an attached honorific", async () => {
    const result = await logInteractionFor(
      "さくらさんとの打ち合わせをログに残して",
    );

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(sakuraId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(4);
    expect(rows[3]?.relationship_id).toBe(sakuraId);
  });

  it("writes a durable row for a Korean name with an attached honorific", async () => {
    const result = await logInteractionFor("김철수님과 미팅");

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(kimId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(5);
    expect(rows[4]?.relationship_id).toBe(kimId);
  });

  it("writes no row for a kana name inside a longer word", async () => {
    const result = await logInteractionFor("さくらんぼを食べた");

    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    const rows = await interactionRows();
    expect(rows).toHaveLength(5);
  });

  it("writes a durable row for a Chinese name in an ordinary sentence", async () => {
    const result = await logInteractionFor("请记录今天和张三的午餐交流");

    expect(result.success).toBe(true);
    expect(result.data?.interaction?.relationshipId).toBe(zhangSanId);
    const rows = await interactionRows();
    expect(rows).toHaveLength(6);
    expect(rows[5]?.relationship_id).toBe(zhangSanId);
  });

  it("writes no row for a Chinese name inside a longer name", async () => {
    const result = await logInteractionFor("请记录今天和张三丰的午餐交流");

    expect(result.data?.error).toBe("MISSING_EDGE_ID");
    const rows = await interactionRows();
    expect(rows).toHaveLength(6);
  });
});
