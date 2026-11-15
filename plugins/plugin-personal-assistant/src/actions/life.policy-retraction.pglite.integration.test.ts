/** Reminder-policy writes and recent-save retraction through the real executor/service/PGlite path. */
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { resolveOwnerFactStore } from "../lifeops/owner/fact-store.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  clearRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";
import { runLifeOperationHandler } from "./life.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
const created: string[] = [];

beforeAll(async () => {
  vi.setSystemTime(new Date("2026-10-02T20:00:00.000Z"));
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  const ownerId = service.ownerEntityId() as UUID;
  if (!(await fixture.runtime.getEntityById(ownerId))) {
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Policy fixture owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Policy owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Policy owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await clearRecentLifeSaveCache(fixture.runtime, conversation());
  await resolveOwnerFactStore(fixture.runtime).clear();
  const remaining = new Set(
    (await service.listDefinitions()).map((entry) => entry.definition.id),
  );
  for (const id of created.splice(0)) {
    if (remaining.has(id)) await service.deleteDefinition(id);
  }
});
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function conversation(): Memory {
  return { roomId, entityId: service.ownerEntityId() as UUID } as Memory;
}

async function seed(
  title: string,
  steps = [{ channel: "in_app" as const, offsetMinutes: 0, label: "Notify" }],
) {
  const record = await service.createDefinition({
    title,
    kind: "habit",
    timezone: "UTC",
    priority: 3,
    cadence: {
      kind: "once",
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: { steps },
  });
  created.push(record.definition.id);
  return record;
}

function ownerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: { text, source: "client_chat" },
  } as Memory;
}

// Policy operations are not on the OWNER_REMINDERS action enum; they reach
// the shared handler through the routed subaction, so call it directly.
async function invokePolicy(params: Record<string, unknown>, text: string) {
  const message = ownerMessage(text);
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  return runLifeOperationHandler(fixture.runtime, message, undefined, {
    parameters: {
      ...params,
      subaction: params.action,
      ownerSurface: "OWNER_REMINDERS",
    },
  });
}

async function invoke(params: Record<string, unknown>, text: string) {
  const message = ownerMessage(text);
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  return executePlannedToolCall(
    fixture.runtime,
    {
      message,
      userRoles: ["OWNER"],
      activeContexts: ["general", "tasks"],
      replyOwner: "planner",
    },
    { name: "OWNER_REMINDERS", params },
  );
}

async function isLive(id: string): Promise<boolean> {
  return (await service.listDefinitions()).some(
    (entry) =>
      entry.definition.id === id && entry.definition.status === "active",
  );
}

async function rememberSave(record: Awaited<ReturnType<typeof seed>>) {
  await writeRecentLifeSaveCache(fixture.runtime, conversation(), {
    definitionId: record.definition.id,
    title: record.definition.title,
    createdAt: Date.now(),
    sourceMessageId: crypto.randomUUID(),
  });
}

it("writes the global intensity when no target is named, even if a title shares a word", async () => {
  const dinner = await seed("Make dinner");
  const result = await invokePolicy(
    {
      action: "policy_set_reminder",
      details: { intensity: "minimal" },
    },
    "make my reminders less persistent",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.text).toContain("Global");
  const facts = await resolveOwnerFactStore(fixture.runtime).read();
  expect(facts.reminderIntensity?.value).toBe("minimal");
  const preference = await service.getReminderPreference(dinner.definition.id);
  expect(preference.definition?.source).not.toBe("definition_metadata");
});

it("asks instead of writing when a named target only shares a word with a title", async () => {
  const dinner = await seed("Make dinner");
  const result = await invokePolicy(
    {
      action: "policy_set_reminder",
      target: "make the bed",
      details: { intensity: "persistent" },
    },
    "make the bed reminder more persistent",
  );
  expect(result.success).toBe(false);
  expect(result.text).toContain("make the bed");
  expect(
    (await resolveOwnerFactStore(fixture.runtime).read()).reminderIntensity,
  ).toBeUndefined();
  const preference = await service.getReminderPreference(dinner.definition.id);
  expect(preference.definition?.source).not.toBe("definition_metadata");
});

it("refuses a global escalation rule and stores nothing", async () => {
  const result = await invokePolicy(
    {
      action: "policy_configure_escalation",
      details: { callAfterMinutes: 20 },
    },
    "if I ignore a reminder for 20 minutes, call me",
  );
  expect(result.success).toBe(false);
  expect(result.text).toContain("not supported yet");
  expect(
    (await resolveOwnerFactStore(fixture.runtime).read()).escalationRules,
  ).toBeUndefined();
});

it("adds a call step at the requested time and keeps the existing sms step", async () => {
  const medication = await seed("Medication", [
    { channel: "in_app", offsetMinutes: 0, label: "Notify" },
    { channel: "sms", offsetMinutes: 10, label: "Text" },
  ]);
  const result = await invokePolicy(
    {
      action: "policy_configure_escalation",
      target: "my medication reminder",
      details: { callAfterMinutes: 30 },
    },
    "for my medication reminder, call me if I don't respond in 30 minutes",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  const stored = await service.getDefinition(medication.definition.id);
  expect(
    stored.reminderPlan?.steps.map((step) => [
      step.channel,
      step.offsetMinutes,
    ]),
  ).toEqual([
    ["in_app", 0],
    ["sms", 10],
    ["voice", 30],
  ]);
});

it("leaves the plan unchanged when no timing or steps are given, or a channel is unknown", async () => {
  const medication = await seed("Medication", [
    { channel: "sms", offsetMinutes: 5, label: "Text" },
  ]);
  for (const details of [
    {},
    { steps: [{ channel: "pager", offsetMinutes: 5 }] },
  ]) {
    const result = await invokePolicy(
      {
        action: "policy_configure_escalation",
        target: "Medication",
        details,
      },
      "escalate my medication reminder",
    );
    expect(result.success).toBe(false);
  }
  const stored = await service.getDefinition(medication.definition.id);
  expect(stored.reminderPlan?.steps).toEqual(medication.reminderPlan?.steps);
});

it("still retracts the recent save on a bare retraction", async () => {
  const stretch = await seed("Stretch");
  await rememberSave(stretch);
  const result = await invoke(
    { action: "delete" },
    "actually don't save that one",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await isLive(stretch.definition.id)).toBe(false);
});

it("retracts the recent save when the planner target is a pronoun", async () => {
  const stretch = await seed("Stretch");
  await rememberSave(stretch);
  const result = await invoke(
    { action: "delete", target: "that one" },
    "actually don't save that one",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await isLive(stretch.definition.id)).toBe(false);
});

it("deletes the named reminder, not the recent save", async () => {
  const dentist = await seed("Dentist");
  const stretch = await seed("Stretch");
  await rememberSave(stretch);
  await invoke(
    { action: "delete", target: "Dentist" },
    "delete it, the dentist reminder",
  );
  expect(await isLive(stretch.definition.id)).toBe(true);
  expect(await isLive(dentist.definition.id)).toBe(false);
});

it("does not delete the recent save for an edit that mentions setting it", async () => {
  const stretch = await seed("Stretch");
  await rememberSave(stretch);
  await invoke(
    {
      action: "update",
      target: stretch.definition.id,
      details: { description: "at 9 instead" },
    },
    "don't forget to set it for 9 instead",
  );
  expect(await isLive(stretch.definition.id)).toBe(true);
});
