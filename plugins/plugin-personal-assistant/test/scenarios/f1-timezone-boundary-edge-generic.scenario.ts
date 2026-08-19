/**
 * F1 neurotypical-control-adversarial (pr-deterministic). CONTROL/CANARY: a
 * generic (non-traveler) owner asks for a reminder at a literal wall-clock time
 * in a named zone, and it fires at exactly that instant — no biological-night
 * reflag, no traveler-style re-anchoring to a "current trip" zone, no shift of
 * the fire to a nearby "friendlier" hour. Proves the C1 traveler timezone-truth
 * accommodations (re-anchor-on-tz-change, biological-night meeting flags) do NOT
 * leak into a plain profile. Drives the REAL scheduler tick (logical clock, no
 * LLM, no key) with a zone-anchored daily cron whose literal 07:30 America/
 * New_York occurrence must fire at its true UTC instant and NOT at 07:30 UTC.
 *
 * The zone boundary is load-bearing: 07:30 in America/New_York is NOT 07:30 UTC.
 * A tick at 07:30 UTC (the naive wall-clock instant) must record no fire; the
 * tick at the true zone instant (12:30 UTC during EDT / 11:30 during EST — the
 * scenario anchors to the real next occurrence, so the tz math is done by the
 * scheduler, not hard-coded) fires exactly once. A regression that dropped the
 * `tz` and treated the cron as host-local would fire at the wrong tick.
 *
 * Tasks are created through the REAL REST surface; ticks are the REAL scheduler
 * entry. Delivery goes through a scenario-registered always-delivering channel.
 * Run keyless with `TZ=UTC`. Creation is pinned via `createdAtIso`
 * (CREATED_AT_INSTANT) so the tested occurrence is deterministically the first
 * one at/after creation — otherwise the 36h cron catch-up window would fire a
 * just-missed prior-day occurrence at the naive tick on runs that happen to
 * create the task shortly before that day's occurrence (a wall-clock flake, not
 * a tz bug). The catch-up window itself is intentional and load-bearing for
 * other scheduled items (e.g. traveler-reanchor), so it is left untouched.
 *
 * Fail-without-fix anchor: revert the cron `tz` resolution in `cronDue`
 * (`plugins/plugin-scheduling/src/scheduled-task/due.ts`, via `resolveTriggerTz`
 * + `computeNextCronRunAtMs`) so the daily cron is evaluated in the host zone
 * instead of America/New_York: the occurrence collapses onto 07:30 UTC, the
 * naive-UTC tick fires, and the literal-instant fire turn plus the
 * single-delivery finalCheck fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "f1-timezone-boundary-edge-generic";
const ZONE = "America/New_York";
const LOCAL_HOUR = 7;
const LOCAL_MINUTE = 30;
const DELIVERY_CHANNEL_KIND = "scenario_f1_control_tz_delivery";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Resolve the true UTC instant of the next LOCAL_HOUR:LOCAL_MINUTE occurrence in
// ZONE at least `minAheadMs` from now, letting the platform's Intl tz database
// do the offset math (so the proof is correct under both EDT and EST). The
// scheduler must land the fire at THIS instant, not at the naive host-local one.
function nextZoneInstant(minAheadMs: number): Date {
  const start = new Date(Date.now() + minAheadMs);
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const probe = new Date(start.getTime() + dayOffset * DAY_MS);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(probe);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const y = get("year");
    const m = get("month");
    const d = get("day");
    // Build the UTC instant for LOCAL_HOUR:LOCAL_MINUTE on this zone-local date
    // by measuring the zone's offset at a same-day noon probe.
    const noonUtcGuess = new Date(`${y}-${m}-${d}T12:00:00Z`);
    const zoneNoonParts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(noonUtcGuess);
    const zoneNoonHour = Number(
      zoneNoonParts.find((p) => p.type === "hour")?.value ?? "12",
    );
    const offsetHours = 12 - zoneNoonHour; // UTC = zone + offsetHours
    const instant = new Date(
      `${y}-${m}-${d}T${String(LOCAL_HOUR).padStart(2, "0")}:${String(
        LOCAL_MINUTE,
      ).padStart(2, "0")}:00Z`,
    );
    instant.setUTCHours(instant.getUTCHours() + offsetHours);
    if (instant.getTime() >= start.getTime()) return instant;
  }
  throw new Error(`could not resolve next ${ZONE} occurrence`);
}

const ZONE_INSTANT = nextZoneInstant(3 * HOUR_MS);
// The naive host-local wall-clock instant (07:30 UTC on the SAME zone-local
// date) — a re-anchoring/tz-dropping regression would fire here instead.
const NAIVE_UTC_INSTANT = (() => {
  const naive = new Date(ZONE_INSTANT);
  naive.setUTCHours(LOCAL_HOUR, LOCAL_MINUTE, 0, 0);
  // If the zone instant already precedes 07:30 UTC that day, the naive tick is
  // still a distinct earlier wall-clock probe on the same date.
  return naive;
})();
const ZONE_TICK = new Date(ZONE_INSTANT.getTime() + MINUTE_MS);
// Pin the reminder's creation instant 12h before the tested occurrence so the
// proof is deterministic rather than a function of the real wall-clock at run
// time. It lands strictly between the PRIOR 07:30-NY occurrence (~24h earlier)
// and the naive tick (~4h earlier than ZONE_INSTANT), so the ONLY occurrence at
// or after creation is ZONE_INSTANT itself: the cron catch-up window has no
// stale prior-day occurrence to pick up at the naive tick. Without it, a run
// that happens to create the task in the ~3h before that day's occurrence would
// see the catch-up window fire the just-missed occurrence at the naive tick —
// a real-time-dependent flake, not a tz regression. The repository preserves a
// caller-supplied `createdAtIso` (it only backfills from the row insert time
// when absent), so this reaches `cronDue` verbatim.
const CREATED_AT_INSTANT = new Date(ZONE_INSTANT.getTime() - 12 * HOUR_MS);
const CRON_EXPRESSION = `${LOCAL_MINUTE} ${LOCAL_HOUR} * * *`;

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
const captured: { taskId: string | null } = { taskId: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seedChannel(ctx: ScenarioContext): string | undefined {
  deliveryLedger.length = 0;
  captured.taskId = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario F1 control timezone delivery probe" },
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
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
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
    });
  }
  return fires;
}

function taskFires(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (!captured.taskId) return "taskId was not captured from the create turn";
  return fires.filter((fire) => fire.taskId === captured.taskId);
}

function assertCreated(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  captured.taskId = task.taskId;
  const trigger = isRecord(task.trigger) ? task.trigger : null;
  if (trigger?.kind !== "cron" || trigger.tz !== ZONE) {
    return `expected a zone-anchored cron trigger in ${ZONE}, saw ${JSON.stringify(task.trigger)}`;
  }
  return undefined;
}

// The naive host-local instant is NOT the zone occurrence: no fire here.
function assertNoNaiveFire(_status: number, body: unknown): string | undefined {
  // If the zone instant coincides with 07:30 UTC (offset 0, impossible for
  // America/New_York but guarded anyway), skip this probe.
  if (NAIVE_UTC_INSTANT.getTime() === ZONE_INSTANT.getTime()) return undefined;
  const fires = taskFires(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `reminder must NOT fire at the naive 07:30-UTC instant (that is not 07:30 ${ZONE}), saw ${JSON.stringify(fired)}`;
  }
  return undefined;
}

// The true zone instant fires exactly once — the literal wall-clock time was
// honored in the configured zone, not re-anchored or shifted.
function assertZoneFire(_status: number, body: unknown): string | undefined {
  const fires = taskFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1 || fires[0]?.status !== "fired") {
    return `expected exactly one fire at the literal ${ZONE} occurrence, saw ${JSON.stringify(fires)}`;
  }
  if (fires[0].reason !== "cron_due") {
    return `expected fired(cron_due) at the zone instant, saw ${JSON.stringify(fires[0])}`;
  }
  if (deliveryLedger.length !== 1) {
    return `expected exactly one delivery at the zone instant, saw ${deliveryLedger.length}`;
  }
  return undefined;
}

export default scenario({
  id: "f1-timezone-boundary-edge-generic",
  lane: "pr-deterministic",
  title:
    "Control baseline: a literal zoned reminder fires at its true wall-clock instant, no re-anchoring",
  domain: "lifeops",
  evidenceScope: "domain-contract",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "control",
    "personas",
    "timezone",
    "scheduled-tasks",
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
      name: "register the delivery channel and reset the ledger",
      apply: seedChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "F1 Control Timezone Boundary",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "schedule a literal 07:30 America/New_York reminder over REST",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "leave for the 8am parent-teacher conference",
        trigger: { kind: "cron", expression: CRON_EXPRESSION, tz: ZONE },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-zoned`,
        metadata: {
          scenario: SCENARIO_ID,
          createdAtIso: CREATED_AT_INSTANT.toISOString(),
        },
      },
      expectedStatus: 201,
      assertResponse: assertCreated,
    },
    {
      kind: "tick",
      name: "tick at the naive 07:30-UTC instant → no fire (that is not the zone time)",
      worker: "lifeops_scheduler",
      options: { now: NAIVE_UTC_INSTANT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertNoNaiveFire,
    },
    {
      kind: "tick",
      name: "tick at the true America/New_York instant → fires exactly once",
      worker: "lifeops_scheduler",
      options: { now: ZONE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertZoneFire,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — at the literal zoned instant, never the naive UTC one",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (at the true ${ZONE} instant), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
