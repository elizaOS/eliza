/**
 * C1 traveler-timezone-truth (pr-deterministic). Disambiguates the two reminder
 * semantics elena_road conflates in one breath — "text me in ~3 hours when I
 * board" (an ABSOLUTE instant that must NOT drift) vs "every morning remind me
 * to check messages" (a WALL-CLOCK habit that SHOULD track wherever she is).
 * Where the sibling re-anchor scenario proves the `cron` path, this one proves
 * the OTHER wall-clock trigger the scheduler exposes — `during_window`, which
 * resolves through the owner's learned morning window in the owner's EFFECTIVE
 * timezone (`nextWindowStartIso`, keyed off `facts.timezone`). Drives the REAL
 * scheduler tick (logical clock, no LLM, no key). Maps to the bench premise
 * `traveler.explicit_absolute_instant_call_reminder` /
 * `traveler.local_wall_clock_wake_reminder`; the live conversational judge stays
 * on the bench LIVE surface.
 *
 *   - during_window "morning" — is due only when the tick instant falls inside
 *     the owner's morning window rendered in the EFFECTIVE timezone. The chosen
 *     tick (23:00Z) is 08:00 in Asia/Tokyo (inside the 07:30–10:00 window) but
 *     19:00 in New York (well outside it). It fires ONLY because travel
 *     re-anchored the window to the destination; under the home zone it would be
 *     `window_inactive`.
 *   - once { atIso } — `onceDue` never reads a timezone; its occurrence is the
 *     parsed UTC instant verbatim, unmoved by the travel signal.
 *
 * `activeTravel` is DERIVED against the real wall clock in `ownerFactsToView`,
 * so the seeded window brackets REAL now with a far-future `endIso` (which also
 * survives `reconcileTravelActive(tickNow)`); the tick `now` is far in the
 * future so only the injected clock decides dueness. Run keyless with `TZ=UTC`.
 *
 * Fail-without-fix anchor: revert the effective-timezone override in
 * `ownerFactsToView` (`plugin-personal-assistant/.../owner/fact-store.ts`) so
 * `duringWindowDue` reads the home zone; the 23:00Z tick (19:00 in New York)
 * then reads as `window_inactive` and the morning-window reminder never fires —
 * the wall-clock assertion fails while the absolute-instant assertion still
 * passes.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "traveler-absolute-vs-wallclock-disambiguation-flight";
const DELIVERY_CHANNEL_KIND = "scenario_traveler_disambig_delivery";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

// 23:00Z is 08:00 in Asia/Tokyo (inside the 07:30–10:00 morning window) and
// 19:00 in America/New_York (well outside it) — so a `during_window:"morning"`
// fire at this instant is only possible under the re-anchored destination zone.
const TICK = futureDateAtUtc(23, 0, 2);
const BOARDING_INSTANT = futureDateAtUtc(22, 0, 2); // fixed absolute instant, before the tick

const HOME_TZ = "America/New_York";
const DESTINATION_TZ = "Asia/Tokyo";
const MORNING_START_LOCAL = "07:30";

interface ChannelContributionLike {
  kind: string;
  describe: { label: string };
  capabilities: {
    send: boolean;
    read: boolean;
    reminders: boolean;
    voice: boolean;
    attachments: boolean;
    quietHoursAware: boolean;
  };
  send?(payload: unknown): Promise<{ ok: true; messageId: string }>;
}

interface ChannelRegistryLike {
  register(contribution: ChannelContributionLike): void;
  get(kind: string): ChannelContributionLike | null;
}

interface RuntimeLike {
  channelRegistry?: ChannelRegistryLike;
}

const deliveryLedger: unknown[] = [];

const capturedTaskIds: { window: string | null; absolute: string | null } = {
  window: null,
  absolute: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedTravelAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.window = null;
  capturedTaskIds.absolute = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario traveler disambiguation delivery probe" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(payload: unknown): Promise<{ ok: true; messageId: string }> {
        deliveryLedger.push(payload);
        return {
          ok: true,
          messageId: `${SCENARIO_ID}-delivered-${deliveryLedger.length}`,
        };
      },
    });
  }

  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  await store.update(
    {
      timezone: HOME_TZ,
      morningWindow: { startLocal: MORNING_START_LOCAL, endLocal: "10:00" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  await store.setActiveTravel(
    {
      startIso: new Date(Date.now() - HOUR_MS).toISOString(),
      endIso: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      destinationTimezone: DESTINATION_TZ,
    },
    { source: "connector_inferred", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
}

function readFires(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskFires;
  if (!Array.isArray(raw)) return "expected scheduledTaskFires array";
  const fires: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed scheduledTaskFires entry: ${JSON.stringify(entry)}`;
    }
    fires.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
      occurrenceAtIso:
        typeof entry.occurrenceAtIso === "string"
          ? entry.occurrenceAtIso
          : undefined,
    });
  }
  return fires;
}

function fireFor(body: unknown, taskId: string | null): FireEntry | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (typeof taskId !== "string") return "captured taskId was not set";
  const mine = fires.filter((fire) => fire.taskId === taskId);
  if (mine.length !== 1 || mine[0]?.status !== "fired") {
    return `expected exactly one fired for task, saw ${JSON.stringify(mine)}`;
  }
  return mine[0];
}

function localHourMinute(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "??";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "??";
  return `${hour}:${minute}`;
}

function captureTaskId(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    if (!isRecord(body) || !isRecord(body.task)) {
      return `expected {task} response, saw ${JSON.stringify(body)}`;
    }
    const task = body.task;
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
    }
    capturedTaskIds[slot] = task.taskId;
    return undefined;
  };
}

function assertDisambiguation(
  _status: number,
  body: unknown,
): string | undefined {
  // The tick's own tz reading is the load-bearing invariant of this proof: it
  // must be inside the destination morning window and outside the home one, so
  // the fire can only come from the re-anchored effective timezone.
  const tickInTokyo = localHourMinute(TICK.toISOString(), DESTINATION_TZ);
  const tickInHome = localHourMinute(TICK.toISOString(), HOME_TZ);
  if (tickInTokyo !== "08:00") {
    return `test setup drift: tick ${TICK.toISOString()} is ${tickInTokyo} in ${DESTINATION_TZ}, expected 08:00`;
  }
  if (
    tickInHome === "07:30" ||
    tickInHome === "08:00" ||
    tickInHome === "09:00"
  ) {
    return `test setup drift: tick ${TICK.toISOString()} (${tickInHome} in ${HOME_TZ}) must be outside the home morning window`;
  }

  // Wall-clock morning window fires ONLY because the window re-anchored to the
  // destination — under the home zone this instant is `window_inactive`.
  const win = fireFor(body, capturedTaskIds.window);
  if (typeof win === "string") return `window: ${win}`;
  if (win.reason !== "window_due") {
    return `expected the morning window to fire (window_due) under the re-anchored destination zone, saw ${JSON.stringify(win)}`;
  }

  // Absolute boarding instant → invariant.
  const abs = fireFor(body, capturedTaskIds.absolute);
  if (typeof abs === "string") return `absolute: ${abs}`;
  if (abs.reason !== "once_due") {
    return `expected absolute-instant once_due, saw ${JSON.stringify(abs)}`;
  }
  if (abs.occurrenceAtIso !== BOARDING_INSTANT.toISOString()) {
    return `absolute boarding reminder moved: occurrence ${abs.occurrenceAtIso}, expected ${BOARDING_INSTANT.toISOString()}`;
  }
  return undefined;
}

export default scenario({
  // Literal (not the SCENARIO_ID const) so the static corpus guard can read it.
  id: "traveler-absolute-vs-wallclock-disambiguation-flight",
  lane: "pr-deterministic",
  title:
    "Traveler: a wall-clock morning window re-anchors to the destination while an absolute boarding instant does not",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "traveler",
    "timezone",
    "personas",
    "12283",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed home timezone + morning window + active travel, register channel",
      apply: seedTravelAndChannel,
    },
  ],
  rooms: [
    { id: "main", source: "telegram", title: "Elena Road Disambiguation" },
  ],
  turns: [
    {
      kind: "api",
      name: "create a wall-clock morning-window reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "check messages every morning wherever I am",
        trigger: { kind: "during_window", windowKey: "morning" },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-morning-window`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("window"),
    },
    {
      kind: "api",
      name: "create an absolute-instant boarding reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "text me when I board, no matter the timezone",
        trigger: { kind: "once", atIso: BOARDING_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-boarding`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("absolute"),
    },
    {
      kind: "tick",
      name: "tick while traveling → wall-clock re-anchors, absolute instant holds",
      worker: "lifeops_scheduler",
      options: { now: TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDisambiguation,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "both the re-anchored window and the absolute instant delivered",
      predicate: (): string | undefined => {
        if (deliveryLedger.length < 2) {
          return `expected >= 2 deliveries (morning window + boarding), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
