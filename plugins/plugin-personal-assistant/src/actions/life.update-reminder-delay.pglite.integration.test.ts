/**
 * Relative-delay owner reminder updates through the real executor, service and
 * PGlite path. Live tj-b020ae0157c06c: "actually make that 30 minutes" after
 * "remind me to stretch in 20 minutes" sent OWNER_REMINDERS_UPDATE
 * {details:{delayMinutes:30}}; the handler ignored the delay, ran an 11 s
 * free-text extraction, and rejected the update.
 */

import type {
  LifeOpsCadence,
  LifeOpsDefinitionRecord,
} from "@elizaos/contracts";
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
import {
  clearRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";
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

function updateReminder(
  params: Record<string, unknown>,
  text = "actually make that 30 minutes",
  name = "OWNER_REMINDERS_UPDATE",
) {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    createdAt: MESSAGE_AT,
    content: { text, source: "client_chat" },
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
        { name, params },
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
])(
  "rejects fractional numeric relative updates without changing the saved definition: %j",
  async (params) => {
    const seeded = await seed("Fraction refusal", STRETCH_CADENCE);
    const result = await updateReminder({
      target: seeded.definition.id,
      ...params,
    });
    expect(result.success).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({ reason: "relative_delay_unusable" }),
    );
    expect(
      (await service.getDefinition(seeded.definition.id)).definition,
    ).toEqual(seeded.definition);
    expect(
      (result.effectReceipts ?? []).some(
        (receipt) => receipt.outcome === "applied",
      ),
    ).toBe(false);
    await service.deleteDefinition(seeded.definition.id);
  },
);

it("keeps valid whole seconds ahead of fractional lower-priority minutes and request fields ahead of details", async () => {
  const seeded = await seed("Whole seconds", STRETCH_CADENCE);
  const result = await updateReminder({
    target: seeded.definition.id,
    delaySeconds: 90,
    delayMinutes: 1.5,
    details: { delaySeconds: 1.9 },
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (await service.getDefinition(seeded.definition.id)).definition.cadence,
  ).toEqual({ ...STRETCH_CADENCE, dueAt: "2026-10-30T12:03:25.162Z" });
  await service.deleteDefinition(seeded.definition.id);
});

it("keeps explicit cadence ahead of fractional delay inputs", async () => {
  const seeded = await seed("Explicit cadence", STRETCH_CADENCE);
  const cadence: LifeOpsCadence = {
    kind: "once",
    dueAt: "2026-10-30T13:00:00.000Z",
  };
  const result = await updateReminder({
    target: seeded.definition.id,
    delayMinutes: 1.5,
    details: { cadence },
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (await service.getDefinition(seeded.definition.id)).definition.cadence,
  ).toEqual(cadence);
  await service.deleteDefinition(seeded.definition.id);
});

// Live on Eliza Cloud the planner invented a non-UUID handle for the target
// while naming the reminder by its real title, and the update refused.
const INVENTED_TARGET_ARGS = {
  action: "update",
  intent: "Change the stretch reminder from 20 minutes to 30 minutes from now",
  title: "Stretch",
  target: "stretch-20min-2026-10-30T13-01z",
  delayMinutes: 30,
};

it("resolves an invented target by the one reminder its title names", async () => {
  const seeded = await seed("Stretch", STRETCH_CADENCE);
  const result = await updateReminder(INVENTED_TARGET_ARGS);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (await service.getDefinition(seeded.definition.id)).definition.cadence,
  ).toEqual({ ...STRETCH_CADENCE, dueAt: "2026-10-30T12:31:55.162Z" });
  expect(result.effectReceipts).toEqual([
    expect.objectContaining({
      outcome: "applied",
      resource: expect.objectContaining({ id: seeded.definition.id }),
    }),
  ]);
  await service.deleteDefinition(seeded.definition.id);
});

it.each([
  { name: "two reminders share the title", titles: ["Stretch", "Stretch"] },
  { name: "no reminder has the title", titles: ["Water plants"] },
])(
  "refuses an invented target without writing when $name",
  async ({ titles }) => {
    const seeded = [];
    for (const title of titles) seeded.push(await seed(title, STRETCH_CADENCE));
    const result = await updateReminder(INVENTED_TARGET_ARGS);
    expect(result.success).toBe(false);
    for (const entry of seeded) {
      expect(
        (await service.getDefinition(entry.definition.id)).definition,
      ).toEqual(entry.definition);
      await service.deleteDefinition(entry.definition.id);
    }
    expect(
      (result.effectReceipts ?? []).some(
        (receipt) => receipt.outcome === "applied",
      ),
    ).toBe(false);
  },
);

it("keeps an existing id ahead of a title that names another reminder", async () => {
  const stretch = await seed("Stretch", STRETCH_CADENCE);
  const oven = await seed("Oven check", STRETCH_CADENCE);
  const result = await updateReminder({
    ...INVENTED_TARGET_ARGS,
    target: oven.definition.id,
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (await service.getDefinition(oven.definition.id)).definition.cadence,
  ).toEqual({ ...STRETCH_CADENCE, dueAt: "2026-10-30T12:31:55.162Z" });
  expect(
    (await service.getDefinition(stretch.definition.id)).definition,
  ).toEqual(stretch.definition);
  await service.deleteDefinition(stretch.definition.id);
  await service.deleteDefinition(oven.definition.id);
});

// A title rescues an invented target only under the target's own guards: on a
// delete it may not alias an item the owner said to keep, nor replace the item
// the owner's words name.
it.each([
  {
    name: "the owner keeps the title's item",
    titles: ["Stretch", "Stretch legs"],
    text: "keep stretch, delete the old one",
  },
  {
    name: "the owner names another item",
    titles: ["Stretch", "Oven check"],
    text: "delete the oven check reminder",
  },
])("refuses a delete by title when $name", async ({ titles, text }) => {
  const seeded = [];
  for (const title of titles) seeded.push(await seed(title, STRETCH_CADENCE));
  const result = await updateReminder(
    { action: "delete", title: "Stretch", target: "old-reminder-0630" },
    text,
    "OWNER_REMINDERS_DELETE",
  );
  expect(result.success, JSON.stringify(result)).toBe(false);
  for (const entry of seeded) {
    expect(
      (await service.getDefinition(entry.definition.id)).definition,
    ).toEqual(entry.definition);
    await service.deleteDefinition(entry.definition.id);
  }
});

// Live tj-82a28eec7f2481 (demo rehearsal): "actually make that 10 minutes"
// after "remind me in 5 minutes to grab the deck" asked "Multiple items match"
// because an earlier "Grab the deck" had already fired.
const REHEARSAL_UPDATE_ARGS = {
  intent:
    "Change the grab-the-deck reminder to fire in 10 minutes from now instead of 5.",
  target: "grab the deck",
  details: { delayMinutes: 10 },
  delayMinutes: 10,
};

it.each([
  { says: "actually make that 10 minutes", saved: "due", moved: "recent" },
  { says: "actually make that 10 minutes", saved: "fired", moved: "recent" },
  {
    says: "move the 5:40am grab the deck to 10 minutes from now",
    saved: "due",
    moved: "earlier",
  },
  {
    says: "move the 5:00am grab the deck to 10 minutes from now",
    saved: "fired",
    moved: "recent",
  },
] as const)(
  "after a $saved save in this conversation, '$says' moves the $moved namesake",
  async ({ says, saved, moved }) => {
    const earlier = await seed("Grab the deck", {
      ...STRETCH_CADENCE,
      dueAt: "2026-10-30T12:40:00.000Z",
    });
    const recent = await seed(
      "Grab the deck",
      saved === "due"
        ? STRETCH_CADENCE
        : { ...STRETCH_CADENCE, dueAt: "2026-10-30T12:00:00.000Z" },
    );
    const conversation = {
      roomId,
      entityId: service.ownerEntityId() as UUID,
    } as Memory;
    try {
      await writeRecentLifeSaveCache(fixture.runtime, conversation, {
        definitionId: recent.definition.id,
        title: recent.definition.title,
        createdAt: Date.now(),
      });
      const result = await updateReminder(REHEARSAL_UPDATE_ARGS, says);
      expect(result.success, JSON.stringify(result)).toBe(true);
      const [target, other] =
        moved === "recent" ? [recent, earlier] : [earlier, recent];
      expect(
        (await service.getDefinition(target.definition.id)).definition.cadence,
      ).toEqual({ ...STRETCH_CADENCE, dueAt: "2026-10-30T12:11:55.162Z" });
      expect(
        (await service.getDefinition(other.definition.id)).definition,
      ).toEqual(other.definition);
    } finally {
      await clearRecentLifeSaveCache(fixture.runtime, conversation);
      for (const entry of [earlier, recent])
        await service.deleteDefinition(entry.definition.id);
    }
  },
);

// Each namesake case the reviews probed, at the trajectory's 5:01 AM PDT clock.
// A row names the one definition that may change. A row without one (except
// the snooze) must ask "Multiple items match" and change nothing, as the base
// resolution does. An edit or cancel by name skips a cancelled namesake. An
// edit that calls the reminder this conversation just saved only "that" or
// "it" follows that reminder. A word or number that could pick another copy
// keeps the base resolution, and the new time an edit asks for picks no copy.
const DUE = {
  fired436: "2026-10-30T11:36:00.000Z",
  fired500: "2026-10-30T12:00:00.000Z",
  live521: STRETCH_CADENCE.dueAt,
  live540: "2026-10-30T12:40:00.000Z",
  yesterday530pm: "2026-10-30T00:30:00.000Z",
  yesterday540am: "2026-10-29T12:40:00.000Z",
  today6pm: "2026-10-31T01:00:00.000Z",
  tomorrow436: "2026-10-31T11:36:00.000Z",
};
const MOVED_10 = "2026-10-30T12:11:55.162Z";
const MAKE_10 = "actually make that 10 minutes";
const cancel = (intent: string) => ({
  action: "cancel",
  title: "Grab the deck",
  kind: "definition",
  intent,
});
const retime = (intent: string, dueAt: string) => ({
  intent,
  target: "grab the deck",
  details: { cadence: { ...STRETCH_CADENCE, dueAt } },
});
type NamesakeSeed = {
  key: string;
  dueAt: string;
  title?: string;
  status?: "archived" | "paused";
};
const FIRED_LIVE: NamesakeSeed[] = [
  { key: "fired436", dueAt: DUE.fired436 },
  { key: "live521", dueAt: DUE.live521 },
];
const THREE: NamesakeSeed[] = [
  ...FIRED_LIVE,
  { key: "live540", dueAt: DUE.live540 },
];
const OLDER_RECENT: NamesakeSeed[] = [
  { key: "older540", dueAt: DUE.live540 },
  { key: "recent521", dueAt: DUE.live521 },
];
const FIRED_RECENT: NamesakeSeed[] = [
  { key: "fired436", dueAt: DUE.fired436 },
  { key: "recent521", dueAt: DUE.live521 },
];

it.each<{
  id: string;
  says: string;
  params: Record<string, unknown>;
  seeds: NamesakeSeed[];
  recent?: string;
  changes?: { key: string; dueAt?: string; status?: string };
  snoozes?: true;
}>([
  // A cancelled namesake is not a candidate. A fired or paused one still is.
  {
    id: "cancelled",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "cancelled540", dueAt: DUE.live540, status: "archived" },
      { key: "live521", dueAt: DUE.live521 },
    ],
    changes: { key: "live521", dueAt: MOVED_10 },
  },
  {
    id: "fired and cancelled",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      ...FIRED_LIVE,
      { key: "cancelled540", dueAt: DUE.live540, status: "archived" },
    ],
  },
  {
    id: "fired and cancelled, live one just saved",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      ...FIRED_LIVE,
      { key: "cancelled540", dueAt: DUE.live540, status: "archived" },
    ],
    recent: "live521",
    changes: { key: "live521", dueAt: MOVED_10 },
  },
  {
    id: "paused",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "paused540", dueAt: DUE.live540, status: "paused" },
      { key: "live521", dueAt: DUE.live521 },
    ],
  },
  {
    id: "cancelled one named by its time",
    says: "cancel the 4:36am grab the deck reminder",
    params: cancel("cancel the 4:36am grab the deck reminder"),
    seeds: [
      { key: "cancelled436", dueAt: DUE.fired436, status: "archived" },
      { key: "live521", dueAt: DUE.live521 },
    ],
    changes: { key: "cancelled436", status: "archived" },
  },
  // The first review's probes A-D.
  {
    id: "A",
    says: "move the 4:36am grab the deck to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: FIRED_LIVE,
    changes: { key: "fired436", dueAt: MOVED_10 },
  },
  {
    id: "B",
    says: "cancel the 4:36am grab the deck reminder",
    params: cancel("cancel the 4:36am grab the deck reminder"),
    seeds: FIRED_LIVE,
    changes: { key: "fired436", status: "archived" },
  },
  {
    id: "C",
    says: "move the 5:00am grab the deck to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "live540", dueAt: DUE.live540 },
      { key: "recent500", dueAt: DUE.fired500 },
    ],
    recent: "recent500",
    changes: { key: "recent500", dueAt: MOVED_10 },
  },
  {
    id: "D",
    says: "cancel the 4:36am one",
    params: cancel("cancel the 4:36am one"),
    seeds: FIRED_LIVE,
    changes: { key: "fired436", status: "archived" },
  },
  // The second review's probes N01-N26.
  {
    id: "N01",
    says: "cancel the 4:36 one",
    params: cancel("cancel the 4:36 one"),
    seeds: FIRED_LIVE,
  },
  {
    id: "N02",
    says: "cancel the 4.36am one",
    params: cancel("cancel the 4.36am one"),
    seeds: FIRED_LIVE,
    changes: { key: "fired436", status: "archived" },
  },
  {
    id: "N03",
    says: "cancel the 436 one",
    params: cancel("cancel the 436 one"),
    seeds: FIRED_LIVE,
  },
  {
    id: "N04",
    says: "cancel the 4:36 a.m. one",
    params: cancel("cancel the 4:36 a.m. one"),
    seeds: FIRED_LIVE,
  },
  {
    id: "N05",
    says: "move the 4:36 one to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: FIRED_LIVE,
  },
  {
    id: "N06",
    says: "cancel the earlier one",
    params: cancel("cancel the earlier one"),
    seeds: FIRED_LIVE,
  },
  {
    id: "N07",
    says: "cancel the one from yesterday",
    params: cancel("cancel the one from yesterday"),
    seeds: [
      { key: "yesterday530pm", dueAt: DUE.yesterday530pm },
      { key: "live521", dueAt: DUE.live521 },
    ],
  },
  {
    id: "N08",
    says: "cancel the one from this morning",
    params: cancel("cancel the one from this morning"),
    seeds: [
      { key: "fired436", dueAt: DUE.fired436 },
      { key: "today6pm", dueAt: DUE.today6pm },
    ],
  },
  { id: "N09", says: MAKE_10, params: REHEARSAL_UPDATE_ARGS, seeds: THREE },
  {
    id: "N10",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: THREE,
    recent: "live521",
    changes: { key: "live521", dueAt: MOVED_10 },
  },
  {
    id: "N11",
    says: "cancel the 5:40am grab the deck reminder",
    params: cancel("cancel the 5:40am grab the deck reminder"),
    seeds: THREE,
    changes: { key: "live540", status: "archived" },
  },
  {
    id: "N12",
    says: "cancel the grab the deck reminder",
    params: cancel("cancel the grab the deck reminder"),
    seeds: THREE,
  },
  // The requested new time names no copy.
  {
    id: "N13",
    says: "actually make that 5:40am",
    params: retime("actually make that 5:40am", DUE.live540),
    seeds: OLDER_RECENT,
    recent: "recent521",
    changes: { key: "recent521", dueAt: DUE.live540 },
  },
  {
    id: "N14",
    says: "actually make that 5:40am",
    params: retime("actually make that 5:40am", DUE.live540),
    seeds: [
      { key: "yesterday540am", dueAt: DUE.yesterday540am },
      { key: "recent521", dueAt: DUE.live521 },
    ],
    recent: "recent521",
    changes: { key: "recent521", dueAt: DUE.live540 },
  },
  {
    id: "N15",
    says: "move the 5:40am one to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: OLDER_RECENT,
    recent: "recent521",
    changes: { key: "older540", dueAt: MOVED_10 },
  },
  {
    id: "N16",
    says: "cancel the 5:40am grab the deck",
    params: cancel("cancel the 5:40am grab the deck"),
    seeds: OLDER_RECENT,
    recent: "recent521",
    changes: { key: "older540", status: "archived" },
  },
  {
    id: "N17",
    says: "move the 4:36 one to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: FIRED_RECENT,
    recent: "recent521",
  },
  // Pre-existing, as at the base commit: titles that differ only in case are
  // namesakes, but titles that differ in punctuation are not. Target "grab the
  // deck" then names only the fired copy, which moves.
  {
    id: "N18",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "fired436", dueAt: DUE.fired436 },
      { key: "live521", dueAt: DUE.live521, title: "grab the Deck" },
    ],
  },
  {
    id: "N19",
    says: "cancel the 4:36am Grab The Deck",
    params: cancel("cancel the 4:36am Grab The Deck"),
    seeds: [
      { key: "fired436", dueAt: DUE.fired436 },
      { key: "live521", dueAt: DUE.live521, title: "grab the Deck" },
    ],
    changes: { key: "fired436", status: "archived" },
  },
  {
    id: "N20",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "fired436", dueAt: DUE.fired436 },
      { key: "live521", dueAt: DUE.live521, title: "Grab the deck." },
    ],
    changes: { key: "fired436", dueAt: MOVED_10 },
  },
  {
    id: "N21",
    says: "snooze the 4:36 one",
    params: {
      action: "snooze",
      title: "Grab the deck",
      kind: "definition",
      intent: "snooze the 4:36 one",
      details: { minutes: 10 },
    },
    seeds: FIRED_LIVE,
    snoozes: true,
  },
  {
    id: "N22",
    says: "cancel the grab the deck reminder",
    params: cancel("cancel the grab the deck reminder"),
    seeds: FIRED_LIVE,
  },
  {
    id: "N23",
    says: "cancel the grab the deck reminder",
    params: cancel("cancel the grab the deck reminder"),
    seeds: [
      { key: "paused540", dueAt: DUE.live540, status: "paused" },
      { key: "live521", dueAt: DUE.live521 },
    ],
  },
  {
    id: "N24",
    says: "move it to 4:36am tomorrow",
    params: retime("move grab the deck to 4:36am tomorrow", DUE.tomorrow436),
    seeds: FIRED_RECENT,
    recent: "recent521",
    changes: { key: "recent521", dueAt: DUE.tomorrow436 },
  },
  {
    id: "N25",
    says: "push the 4:36am grab the deck to 10 minutes from now",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: FIRED_RECENT,
    recent: "recent521",
    changes: { key: "fired436", dueAt: MOVED_10 },
  },
  {
    id: "N26",
    says: "cancel the 4:36 one",
    params: cancel("cancel the 4:36 one"),
    seeds: THREE,
  },
  // Following the reminder just saved needs "that" or "it" and no selector.
  {
    id: "other one",
    says: "actually make the other one 10 minutes",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: OLDER_RECENT,
    recent: "recent521",
  },
  {
    id: "title named",
    says: "actually make grab the deck 10 minutes",
    params: REHEARSAL_UPDATE_ARGS,
    seeds: OLDER_RECENT,
    recent: "recent521",
  },
  {
    id: "saved one since cancelled",
    says: MAKE_10,
    params: REHEARSAL_UPDATE_ARGS,
    seeds: [
      { key: "older540", dueAt: DUE.live540 },
      { key: "recent521", dueAt: DUE.live521, status: "archived" },
    ],
    recent: "recent521",
  },
  {
    id: "the reminder, just saved",
    says: "move the reminder to 4:36am tomorrow",
    params: retime("move the reminder to 4:36am tomorrow", DUE.tomorrow436),
    seeds: FIRED_RECENT,
    recent: "recent521",
    changes: { key: "recent521", dueAt: DUE.tomorrow436 },
  },
  // The new time is never a time hint, even where the base resolution reads
  // one, so it cannot pick the copy that already has that time.
  {
    id: "new time, no save",
    says: "actually make that 5:40am",
    params: retime("actually make that 5:40am", DUE.live540),
    seeds: [
      { key: "older540", dueAt: DUE.live540 },
      { key: "live521", dueAt: DUE.live521 },
    ],
  },
  {
    id: "new time, title named",
    says: "move grab the deck to 4:36am tomorrow",
    params: retime("move grab the deck to 4:36am tomorrow", DUE.tomorrow436),
    seeds: FIRED_RECENT,
    recent: "recent521",
  },
  {
    id: "new time, cancelled copy",
    says: "actually make that 5:40am",
    params: retime("actually make that 5:40am", DUE.live540),
    seeds: [
      { key: "cancelled540", dueAt: DUE.live540, status: "archived" },
      { key: "live521", dueAt: DUE.live521 },
    ],
    changes: { key: "live521", dueAt: DUE.live540 },
  },
])(
  "$id: '$says' changes only the namesake it names, or asks",
  async ({ says, params, seeds, recent, changes, snoozes }) => {
    const seeded = new Map<string, LifeOpsDefinitionRecord>();
    const conversation = {
      roomId,
      entityId: service.ownerEntityId() as UUID,
    } as Memory;
    try {
      for (const { key, dueAt, title, status } of seeds) {
        const created = await seed(title ?? "Grab the deck", {
          ...STRETCH_CADENCE,
          dueAt,
        });
        seeded.set(
          key,
          status
            ? await service.updateDefinition(created.definition.id, { status })
            : created,
        );
      }
      const saved = recent ? seeded.get(recent) : undefined;
      if (saved)
        await writeRecentLifeSaveCache(fixture.runtime, conversation, {
          definitionId: saved.definition.id,
          title: saved.definition.title,
          createdAt: Date.now(),
        });
      const result = await updateReminder(
        params,
        says,
        "action" in params ? "OWNER_REMINDERS" : "OWNER_REMINDERS_UPDATE",
      );
      expect(result.success, JSON.stringify(result)).toBe(
        Boolean(changes || snoozes),
      );
      if (!changes && !snoozes)
        expect(result.text).toContain("Multiple items match");
      for (const [key, entry] of seeded) {
        const stored = (await service.getDefinition(entry.definition.id))
          .definition;
        if (key !== changes?.key) {
          expect(stored, key).toEqual(entry.definition);
          continue;
        }
        expect(stored.status).toBe(changes.status ?? entry.definition.status);
        expect(stored.cadence).toMatchObject({
          kind: "once",
          dueAt: changes.dueAt ?? seeds.find((s) => s.key === key)?.dueAt,
        });
      }
      const others = [...seeded]
        .filter(([key]) => key !== changes?.key)
        .map(([, entry]) => entry.definition.id);
      expect(
        (result.effectReceipts ?? []).filter(
          (receipt) =>
            receipt.outcome === "applied" &&
            others.includes(receipt.resource.id),
        ),
      ).toEqual([]);
    } finally {
      await clearRecentLifeSaveCache(fixture.runtime, conversation);
      for (const entry of seeded.values())
        await service.deleteDefinition(entry.definition.id);
    }
  },
);
