/**
 * Relative-delay owner reminder updates through the real executor, service and
 * PGlite path. Live tj-b020ae0157c06c: "actually make that 30 minutes" after
 * "remind me to stretch in 20 minutes" sent OWNER_REMINDERS_UPDATE
 * {details:{delayMinutes:30}}; the handler ignored the delay, ran an 11 s
 * free-text extraction, and rejected the update.
 */

import type { LifeOpsCadence } from "@elizaos/contracts";
import {
  actionToTool,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  promoteSubactionsToActions,
  TaskService,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import { ownerRemindersAction } from "./owner-surfaces.js";

// The trajectory's clock: 5:01 AM in Los Angeles, the message sent at
// 12:01:55.162Z (its rejected receipt's observedAt).
const NOW = "2026-10-30T12:01:55.921Z";
const MESSAGE_AT = Date.parse("2026-10-30T12:01:55.162Z");

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
beforeAll(async () => {
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  const ownerId = service.ownerEntityId() as UUID;
  if (!(await fixture.runtime.getEntityById(ownerId))) {
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Reminder update owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Reminder update world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Reminder update DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);
beforeEach(() => {
  // The planner owns the reply, and a structured delay needs no extraction.
  vi.spyOn(fixture.runtime, "useModel").mockRejectedValue(
    Error("A relative-delay update must not invoke a model"),
  );
});
afterEach(() => {
  expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** The definition OWNER_REMINDERS_CREATE saved for "stretch in 20 minutes". */
function seed(title: string, cadence: LifeOpsCadence) {
  return service.createDefinition({
    title,
    description: "",
    kind: "habit",
    timezone: "America/Los_Angeles",
    priority: 3,
    cadence,
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: {
      steps: [
        { channel: "in_app", offsetMinutes: 0, label: `${title} reminder` },
      ],
    },
  });
}

const STRETCH_CADENCE: LifeOpsCadence = {
  kind: "once",
  dueAt: "2026-10-30T12:21:49.619Z",
  visibilityLeadMinutes: 0,
};
const DAILY_CADENCE: LifeOpsCadence = { kind: "daily", windows: ["morning"] };

function updateReminder(params: Record<string, unknown>) {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    createdAt: MESSAGE_AT,
    content: { text: "actually make that 30 minutes", source: "client_chat" },
  } as Memory;
  return attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message).then(
    () =>
      executePlannedToolCall(
        fixture.runtime,
        {
          message,
          userRoles: ["OWNER"],
          activeContexts: ["general", "tasks"],
          replyOwner: "planner",
        },
        { name: "OWNER_REMINDERS_UPDATE", params },
      ),
  );
}

it("replays the live OWNER_REMINDERS_UPDATE args and moves the reminder 30 minutes from the request", async () => {
  const seeded = await seed("Stretch", STRETCH_CADENCE);
  // Live, this call spent 11.3 s in a reasoning extraction. The afterEach
  // check proves no model runs now.
  const result = await updateReminder({
    title: "Stretch",
    target: "Stretch",
    details: { delayMinutes: 30 },
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const stored = await service.getDefinition(seeded.definition.id);
  expect(stored.definition.cadence).toEqual({
    kind: "once",
    dueAt: "2026-10-30T12:31:55.162Z",
    visibilityLeadMinutes: 0,
  });
  expect(stored.definition.title).toBe("Stretch");
  expect(result.effectReceipts).toEqual([
    expect.objectContaining({
      outcome: "applied",
      operation: "lifeops.definition.update",
      resource: expect.objectContaining({ id: seeded.definition.id }),
    }),
  ]);
  // The reply, or the planner's grounding for it, names the new clock time in
  // the owner's zone (5:31 AM PDT).
  const replyGrounding = (result.data as { replyGrounding?: unknown })
    .replyGrounding;
  expect(`${result.text ?? ""}${replyGrounding ?? ""}`).toContain(
    "Moved Stretch to 5:31 AM.",
  );
  await service.deleteDefinition(seeded.definition.id);
});

it("reads delaySeconds before delayMinutes, the tool parameter before details", async () => {
  const seeded = await seed("Oven check", STRETCH_CADENCE);
  const result = await updateReminder({
    target: seeded.definition.id,
    delaySeconds: 90,
    details: { delayMinutes: 30 },
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const stored = await service.getDefinition(seeded.definition.id);
  expect(stored.definition.cadence).toEqual({
    kind: "once",
    dueAt: "2026-10-30T12:03:25.162Z",
    visibilityLeadMinutes: 0,
  });
  await service.deleteDefinition(seeded.definition.id);
});

it.each([
  {
    name: "a recurring reminder",
    cadence: DAILY_CADENCE,
    details: { delayMinutes: 30 },
    says: "repeats",
  },
  {
    name: "a delay that is not a positive whole number",
    cadence: STRETCH_CADENCE,
    details: { delayMinutes: 0 },
    says: "How many minutes from now",
  },
])(
  "changes nothing and says why for $name",
  async ({ cadence, details, says }) => {
    const seeded = await seed("Water plants", cadence);
    const result = await updateReminder({ target: "Water plants", details });
    expect(result.success).toBe(false);
    expect(result.text).toContain(says);
    const stored = await service.getDefinition(seeded.definition.id);
    expect(stored.definition).toEqual(seeded.definition);
    await service.deleteDefinition(seeded.definition.id);
  },
);

it("declares the relative delay on OWNER_REMINDERS_UPDATE only", () => {
  const virtuals = promoteSubactionsToActions(ownerRemindersAction);
  const properties = (name: string) => {
    const virtual = virtuals.find((action) => action.name === name);
    if (!virtual) throw new Error(`${name} was not promoted`);
    return Object.keys(
      actionToTool(virtual).function.parameters.properties ?? {},
    );
  };
  expect(properties("OWNER_REMINDERS_UPDATE")).toEqual(
    expect.arrayContaining(["delayMinutes", "delaySeconds"]),
  );
  expect(properties("OWNER_REMINDERS_CREATE")).not.toContain("delayMinutes");
  expect(ownerRemindersAction.description).toContain("delayMinutes");
  expect(ownerRemindersAction.routingHint).toContain(
    "'actually make that 30 minutes' -> OWNER_REMINDERS_UPDATE with delayMinutes",
  );
});

it.each([
  { delayMinutes: 1.5 },
  { delaySeconds: 1.9 },
  { details: { delayMinutes: 1.5 } },
  { details: { delaySeconds: 1.9 } },
  { delaySeconds: 1.9, delayMinutes: 30 },
  { details: { delaySeconds: 1.9, delayMinutes: 30 } },
])("rejects fractional numeric relative updates without changing the saved definition: %j", async (params) => {
  const seeded = await seed("Fraction refusal", STRETCH_CADENCE);
  const result = await updateReminder({ target: seeded.definition.id, ...params });
  expect(result.success).toBe(false);
  expect(result.data).toEqual(expect.objectContaining({ reason: "relative_delay_unusable" }));
  expect((await service.getDefinition(seeded.definition.id)).definition).toEqual(seeded.definition);
  expect((result.effectReceipts ?? []).some(receipt => receipt.outcome === "applied")).toBe(false);
  await service.deleteDefinition(seeded.definition.id);
});

it("keeps valid whole seconds ahead of fractional lower-priority minutes and request fields ahead of details", async () => {
  const seeded = await seed("Whole seconds", STRETCH_CADENCE);
  const result = await updateReminder({ target: seeded.definition.id, delaySeconds: 90, delayMinutes: 1.5, details: { delaySeconds: 1.9 } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await service.getDefinition(seeded.definition.id)).definition.cadence).toEqual({ ...STRETCH_CADENCE, dueAt: "2026-10-30T12:03:25.162Z" });
  await service.deleteDefinition(seeded.definition.id);
});

it("keeps explicit cadence ahead of fractional delay inputs", async () => {
  const seeded = await seed("Explicit cadence", STRETCH_CADENCE);
  const cadence: LifeOpsCadence = { kind: "once", dueAt: "2026-10-30T13:00:00.000Z" };
  const result = await updateReminder({ target: seeded.definition.id, delayMinutes: 1.5, details: { cadence } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await service.getDefinition(seeded.definition.id)).definition.cadence).toEqual(cadence);
  await service.deleteDefinition(seeded.definition.id);
});
