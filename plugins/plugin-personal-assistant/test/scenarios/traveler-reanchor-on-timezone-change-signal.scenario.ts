/**
 * C1 traveler-timezone-truth (pr-deterministic). The load-bearing timezone
 * truth for elena_road: when she is inside an active-travel window whose
 * destination timezone differs from her home zone, a WALL-CLOCK reminder
 * ("every morning at 08:00") re-anchors to the destination, while an
 * ABSOLUTE-INSTANT reminder (a fixed `atIso`) never moves. Drives the REAL
 * scheduler tick (logical clock, no LLM, no key) and asserts the STRUCTURAL
 * `occurrenceAtIso` each trigger resolves to — the scheduler-side realization of
 * the bench premises `live.traveler.tz_change_reanchor_reminder` /
 * `traveler.reanchor_on_travel_owner_fact`. The live conversational judge of
 * "asked which anchor, then re-anchored" stays on the bench LIVE surface.
 *
 * Three triggers make the contrast auditable:
 *   1. owner_local cron "0 8 * * *" — `tz:"owner_local"` resolves through
 *      `resolveTriggerTz` to the owner's effective timezone, which
 *      `ownerFactsToView` overrides to `activeTravel.destinationTimezone` while
 *      travel is active. Its occurrence renders to 08:00 Asia/Tokyo.
 *   2. fixed America/New_York cron "0 8 * * *" — a concrete IANA zone; the
 *      travel override cannot touch it. Its occurrence stays 08:00 in New York
 *      (the control that proves only `owner_local` re-anchors).
 *   3. once { atIso } — `onceDue` never reads any timezone; its occurrence is
 *      the parsed UTC instant verbatim, invariant across the tz signal.
 *
 * `activeTravel` is DERIVED against the real wall clock in
 * `ownerFactsToView(store.read(), new Date())`, so the seeded window brackets
 * REAL now with a far-future `endIso` (which also survives
 * `reconcileTravelActive(tickNow)`), while the tick `now` values are far in the
 * future so only the injected clock decides dueness. Run keyless with `TZ=UTC`.
 *
 * Fail-without-fix anchor: revert the `owner_local` resolution in
 * `plugin-scheduling/src/scheduled-task/trigger-tz.ts` (return `tz` unchanged)
 * or the travel override in `ownerFactsToView`
 * (`plugin-personal-assistant/.../owner/fact-store.ts`) and the owner_local
 * occurrence renders to 08:00 UTC/New-York instead of 08:00 Tokyo — the
 * re-anchor assertion fails while the fixed-NY and once assertions still pass.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "traveler-reanchor-on-timezone-change-signal";
const DELIVERY_CHANNEL_KIND = "scenario_traveler_reanchor_delivery";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The tick is far in the future so ONLY the injected `now` decides dueness. Any
// daytime instant works — the assertion reads each fire's resolved
// `occurrenceAtIso`, not the tick instant.
function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

const TICK = futureDateAtUtc(20, 0, 2); // day+2 20:00Z — after every 08:00-local occurrence
const ONCE_INSTANT = futureDateAtUtc(12, 0, 2); // fixed absolute instant, tz-independent

const HOME_TZ = "America/New_York";
const DESTINATION_TZ = "Asia/Tokyo";

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

// assertResponse receives only (status, body) — captured ids live in module
// state, reset by the seed (mirrors persona.flexible-scheduling).
const capturedTaskIds: {
  wallClock: string | null;
  fixedHome: string | null;
  absolute: string | null;
} = { wallClock: null, fixedHome: null, absolute: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedTravelAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.wallClock = null;
  capturedTaskIds.fixedHome = null;
  capturedTaskIds.absolute = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario traveler re-anchor delivery probe" },
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
    { timezone: HOME_TZ },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  // The travel signal — an active window whose destination overrides the home
  // zone. Bracket REAL now (travelActive is derived against `new Date()`) with a
  // far-future end that also outlives the far-future tick, so
  // reconcileTravelActive(tickNow) never treats it as lapsed.
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

// ---------------------------------------------------------------------------
// Fire readers.
// ---------------------------------------------------------------------------

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

/** Render an ISO instant to local HH:MM in an IANA zone. */
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

/**
 * One tick fires all three reminders (all due at the injected instant). Read
 * every one from the SAME response and assert the tz semantics side by side:
 * the owner_local wall-clock re-anchored, the concrete-home wall-clock stayed
 * put, the absolute instant is invariant.
 */
function assertTzSemantics(_status: number, body: unknown): string | undefined {
  // 1. owner_local wall-clock → re-anchored to the destination (08:00 Tokyo).
  const wall = fireFor(body, capturedTaskIds.wallClock);
  if (typeof wall === "string") return `wall-clock: ${wall}`;
  if (wall.reason !== "cron_due" || !wall.occurrenceAtIso) {
    return `expected wall-clock cron_due with occurrenceAtIso, saw ${JSON.stringify(wall)}`;
  }
  const wallInTokyo = localHourMinute(wall.occurrenceAtIso, DESTINATION_TZ);
  if (wallInTokyo !== "08:00") {
    return `owner_local cron did not re-anchor to the destination: occurrence ${wall.occurrenceAtIso} is ${wallInTokyo} in ${DESTINATION_TZ}, expected 08:00`;
  }
  const wallInHome = localHourMinute(wall.occurrenceAtIso, HOME_TZ);
  if (wallInHome === "08:00") {
    return `owner_local cron stayed anchored to home (${wall.occurrenceAtIso} is 08:00 in ${HOME_TZ}); the travel override did not apply`;
  }

  // 2. concrete America/New_York wall-clock → immune to the travel override.
  const fixed = fireFor(body, capturedTaskIds.fixedHome);
  if (typeof fixed === "string") return `fixed-home: ${fixed}`;
  if (fixed.reason !== "cron_due" || !fixed.occurrenceAtIso) {
    return `expected fixed-home cron_due with occurrenceAtIso, saw ${JSON.stringify(fixed)}`;
  }
  const fixedInHome = localHourMinute(fixed.occurrenceAtIso, HOME_TZ);
  if (fixedInHome !== "08:00") {
    return `fixed America/New_York cron drifted: occurrence ${fixed.occurrenceAtIso} is ${fixedInHome} in ${HOME_TZ}, expected 08:00`;
  }

  // 3. absolute instant → onceDue never reads tz; occurrence is the raw instant.
  const abs = fireFor(body, capturedTaskIds.absolute);
  if (typeof abs === "string") return `absolute: ${abs}`;
  if (abs.reason !== "once_due") {
    return `expected absolute-instant once_due, saw ${JSON.stringify(abs)}`;
  }
  if (abs.occurrenceAtIso !== ONCE_INSTANT.toISOString()) {
    return `absolute-instant reminder moved: occurrence ${abs.occurrenceAtIso}, expected the fixed instant ${ONCE_INSTANT.toISOString()}`;
  }

  // The load-bearing contrast: the re-anchored wall-clock and the concrete-home
  // wall-clock resolved to DIFFERENT UTC instants for the same "08:00" text.
  if (wall.occurrenceAtIso === fixed.occurrenceAtIso) {
    return `owner_local and concrete-home occurrences must differ under active travel, both were ${wall.occurrenceAtIso}`;
  }
  return undefined;
}

export default scenario({
  // Literal (not the SCENARIO_ID const) so the static corpus guard can read it.
  id: "traveler-reanchor-on-timezone-change-signal",
  lane: "pr-deterministic",
  title:
    "Traveler tz-change: wall-clock reminder re-anchors to destination, absolute instant is invariant",
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
      name: "seed home timezone + active travel to the destination, register channel",
      apply: seedTravelAndChannel,
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elena Road Re-anchor" }],
  turns: [
    {
      kind: "api",
      name: "create a wall-clock morning reminder anchored to the owner's zone",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning call anchored to wherever I am",
        trigger: { kind: "cron", expression: "0 8 * * *", tz: "owner_local" },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-wall-clock`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("wallClock"),
    },
    {
      kind: "api",
      name: "create a wall-clock reminder pinned to a concrete home zone (control)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning call pinned to New York",
        trigger: { kind: "cron", expression: "0 8 * * *", tz: HOME_TZ },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-fixed-home`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("fixedHome"),
    },
    {
      kind: "api",
      name: "create an absolute-instant reminder (fixed UTC, no timezone)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "board the flight, no matter the timezone",
        trigger: { kind: "once", atIso: ONCE_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-absolute`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("absolute"),
    },
    {
      kind: "tick",
      name: "tick while traveling → the three reminders resolve their tz semantics",
      worker: "lifeops_scheduler",
      options: { now: TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTzSemantics,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "all three reminders delivered (re-anchored wall-clock, fixed-home, absolute)",
      predicate: (): string | undefined => {
        if (deliveryLedger.length < 3) {
          return `expected >= 3 deliveries (wall-clock, fixed-home, absolute), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
