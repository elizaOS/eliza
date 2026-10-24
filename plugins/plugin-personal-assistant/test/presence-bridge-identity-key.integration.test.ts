/**
 * An inbound connector message about a saved contact updates that contact's
 * entity instead of creating a second one: the bridge keys the identity by
 * the connector platform (not the room kind), and handles match with or
 * without the "@" mention prefix.
 */
import { TaskService } from "@elizaos/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PresenceSignalBridgeService } from "../src/activity-profile/presence-signal-bridge-service.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;

beforeAll(async () => {
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
});
afterAll(async () => {
  await fixture?.cleanup?.();
});

function telegramGroupMessage(username: string) {
  const runtime = fixture.runtime;
  return {
    runtime,
    source: "telegram",
    message: {
      id: crypto.randomUUID(),
      entityId: crypto.randomUUID(),
      agentId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "hi", source: "telegram", channelType: "GROUP" },
      metadata: {
        type: "message",
        source: "telegram",
        entityUserName: username,
        sender: { id: "777", name: "Priya", username },
      },
    },
  };
}

it("keeps one entity for a saved contact who writes from a Telegram group without the @ prefix", async () => {
  const runtime = fixture.runtime;
  await service.upsertRelationship({
    name: "Priya Mehta",
    primaryChannel: "telegram",
    primaryHandle: "@priyam",
    email: null,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "contact",
    lastContactedAt: null,
    metadata: {},
  });
  const store = await new LifeOpsRepository(runtime).entityStore(
    String(runtime.agentId),
  );
  const persons = async () =>
    (await store.list()).filter((entity) => entity.type === "person");
  const before = await persons();
  const contact = before.find((entity) =>
    entity.identities.some((identity) => identity.handle === "@priyam"),
  );
  expect(contact).toBeDefined();

  const bridge = await PresenceSignalBridgeService.start(runtime);
  try {
    await (
      bridge as unknown as {
        messageReceivedHandler: (payload: unknown) => Promise<void>;
      }
    ).messageReceivedHandler(telegramGroupMessage("priyam"));
  } finally {
    await bridge.stop();
  }

  // No second person for the same handle; the contact's own entity is the
  // one observed.
  const after = await persons();
  expect(after.map((entity) => entity.entityId).sort()).toEqual(
    before.map((entity) => entity.entityId).sort(),
  );
  const observed = after.find(
    (entity) => entity.entityId === contact?.entityId,
  );
  expect(
    observed?.identities.map(
      (identity) => `${identity.platform}:${identity.handle}`,
    ),
  ).toEqual(["telegram:@priyam"]);
  expect(observed?.state?.lastObservedAt).toBeTruthy();
}, 120_000);

it("forgets dedupe fingerprints once they are older than the dedupe window", async () => {
  const runtime = fixture.runtime;
  const bridge = await PresenceSignalBridgeService.start(runtime);
  const internals = bridge as unknown as {
    messageReceivedHandler: (payload: unknown) => Promise<void>;
    recentFingerprints: Map<string, number>;
  };
  const base = Date.parse("2026-10-24T12:00:00.000Z");
  const messageAt = (createdAt: number, username: string) => {
    const payload = telegramGroupMessage(username);
    payload.message.createdAt = createdAt;
    return payload;
  };
  try {
    // Twenty messages from different senders inside one five-second window.
    for (let index = 0; index < 20; index++) {
      await internals.messageReceivedHandler(
        messageAt(base + index * 10, `sender${index}`),
      );
    }
    // A minute later only the newest message can still be a duplicate.
    await internals.messageReceivedHandler(messageAt(base + 60_000, "later"));

    expect(internals.recentFingerprints.size).toBe(1);
  } finally {
    await bridge.stop();
  }
}, 120_000);
