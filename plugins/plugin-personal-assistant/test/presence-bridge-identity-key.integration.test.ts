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
