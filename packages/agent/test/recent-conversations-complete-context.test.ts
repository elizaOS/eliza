/** Runs the recent-conversations provider against real PGlite for an attested owner DM: every authorized cross-room body is inline whether or not a permitted recall action exists, the recall action only adds a room index, and no body-free overflow replacement is offered to the budget. */
import { randomUUID } from "node:crypto";
import {
  type Action,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recentConversationsProvider } from "../src/providers/recent-conversations.ts";

const OWNER_ID = randomUUID() as UUID;
const WORLD_ID = randomUUID() as UUID;
const CURRENT_ROOM = randomUUID() as UUID;
const OTHER_ROOM = randomUUID() as UUID;
const BODIES = [
  "the dentist moved to thursday at 4pm",
  "remember the blue folder is in the car",
];

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;

beforeAll(async () => {
  fixture = await createTestRuntime({
    characterName: "RecentConversationsContext",
    settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
  });
  const { runtime } = fixture;
  await runtime.createEntity({
    id: OWNER_ID,
    agentId: runtime.agentId,
    names: ["Owner"],
  });
  await runtime.ensureWorldExists({
    id: WORLD_ID,
    agentId: runtime.agentId,
    name: "Owner world",
  });
  for (const [id, source] of [
    [CURRENT_ROOM, "client_chat"],
    [OTHER_ROOM, "telegram"],
  ] as const) {
    await runtime.ensureRoomExists({
      id,
      agentId: runtime.agentId,
      worldId: WORLD_ID,
      name: `${source} dm`,
      source,
      type: ChannelType.DM,
    });
    await runtime.ensureParticipantInRoom(OWNER_ID, id);
    await runtime.ensureParticipantInRoom(runtime.agentId, id);
  }
  let createdAt = Date.now() - 60_000;
  for (const text of BODIES) {
    createdAt += 1_000;
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        entityId: OWNER_ID,
        agentId: runtime.agentId,
        roomId: OTHER_ROOM,
        content: { text, source: "telegram" },
        createdAt,
      },
      "messages",
    );
  }
}, 180_000);

afterAll(async () => {
  if (fixture) await fixture.cleanup();
}, 120_000);

async function currentTurn(): Promise<Memory> {
  const message: Memory = {
    id: randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: fixture.runtime.agentId,
    roomId: CURRENT_ROOM,
    content: { text: "when is the dentist again?", source: "client_chat" },
    createdAt: Date.now(),
  };
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  return message;
}

const emptyState = { values: {}, data: {}, text: "" } as State;

it("inlines every authorized cross-room body without a recall action", async () => {
  const result = await recentConversationsProvider.get(
    fixture.runtime,
    await currentTurn(),
    emptyState,
  );
  for (const body of BODIES) expect(result.text).toContain(body);
  expect(result.overflowText).toBeUndefined();
  expect(result.values?.recentConversationCount).toBe(BODIES.length);
}, 60_000);

it("keeps every body inline and only adds a room index when a recall action exists", async () => {
  const recall: Action = {
    name: "MEMORY_SEARCH",
    description: "Search stored memories.",
    contexts: ["memory"],
    similes: [],
    examples: [],
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  fixture.runtime.registerAction(recall);

  const result = await recentConversationsProvider.get(
    fixture.runtime,
    await currentTurn(),
    emptyState,
  );
  for (const body of BODIES) expect(result.text).toContain(body);
  expect(result.text).toContain(`roomId=${OTHER_ROOM}`);
  expect(result.overflowText).toBeUndefined();
  expect(result.values?.recentConversationCount).toBe(BODIES.length);
}, 60_000);
