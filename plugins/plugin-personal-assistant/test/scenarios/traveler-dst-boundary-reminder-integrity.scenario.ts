/**
 * C1 traveler-timezone-truth (pr-deterministic). A daily wall-clock reminder
 * ("08:00 every day") keeps its LOCAL time exactly across a DST transition —
 * never a missed, duplicated, or hour-early fire — even though the underlying
 * UTC instant shifts by an hour when the zone's offset changes. This is the
 * "reminders firing at 3am local" failure class the C1 research cites, proven on
 * the scheduler side. Drives the REAL scheduler tick (logical clock, no LLM, no
 * key) and asserts the STRUCTURAL `occurrenceAtIso` each daily occurrence
 * resolves to. Maps to the bench premise `traveler.dst_boundary_reminder`; the
 * live conversational judge stays on the bench LIVE surface.
 *
 * The transition is the US fall-back on 2026-11-01 (EDT UTC-4 → EST UTC-5):
 *   - the pre-transition occurrence (Oct 31) renders to 08:00 America/New_York
 *     = 12:00Z (EDT);
 *   - the post-transition occurrence (Nov 01) renders to 08:00 America/New_York
 *     = 13:00Z (EST).
 * Same local "08:00", two DIFFERENT UTC instants an hour apart. A naive
 * fixed-offset scheduler would fire the post-DST occurrence at 07:00 local.
 *
 * The cron base is pinned via `metadata.createdAtIso` (the scheduler scans cron
 * occurrences forward from the task's creation instant) so the boundary is
 * deterministic regardless of the test host's wall clock; all instants are in
 * the future relative to the host, so only the injected tick `now` decides
 * dueness. No travel signal — the cron is pinned to a concrete DST-observing
 * zone. Run keyless with `TZ=UTC`.
 *
 * Fail-without-fix anchor: replace the tz-aware `computeNextCronRunAtMs`
 * (`packages/core/src/services/triggerScheduling.ts`) with a fixed-offset
 * computation and the post-DST occurrence renders to 07:00 (not 08:00) in
 * America/New_York — the second-day local-time assertion fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "traveler-dst-boundary-reminder-integrity";
const DELIVERY_CHANNEL_KIND = "scenario_traveler_dst_delivery";

const DST_TZ = "America/New_York";

// The cron base: the scheduler catches up cron occurrences forward from here.
const CRON_BASE_ISO = "2026-10-31T00:00:00.000Z";

// Ticks bracket the 2026-11-01 fall-back. Each is just after its occurrence's
// 08:00 local instant. Pre-DST: Oct 31 08:00 EDT = 12:00Z (tick 12:05Z). After
// that fire the base advances to the tick, so the next occurrence is Nov 01
// 08:00 EST = 13:00Z (tick 13:05Z).
const PRE_DST_TICK = "2026-10-31T12:05:00.000Z";
const POST_DST_TICK = "2026-11-01T13:05:00.000Z";

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
let dailyTaskId: string | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedChannel(ctx: ScenarioContext): Promise<string | undefined> {
  deliveryLedger.length = 0;
  dailyTaskId = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario traveler DST delivery probe" },
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

function dailyFire(body: unknown): FireEntry | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (!dailyTaskId) return "daily taskId was not captured";
  const mine = fires.filter((fire) => fire.taskId === dailyTaskId);
  if (mine.length !== 1 || mine[0]?.status !== "fired") {
    return `expected exactly one fired for the daily task, saw ${JSON.stringify(mine)}`;
  }
  return mine[0];
}

function localHourMinuteDay(
  iso: string,
  timeZone: string,
): { hm: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "??";
  return { hm: `${get("hour")}:${get("minute")}`, day: get("day") };
}

function assertCreated(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  dailyTaskId = task.taskId;
  return undefined;
}

function assertPreDst(_status: number, body: unknown): string | undefined {
  const fire = dailyFire(body);
  if (typeof fire === "string") return fire;
  if (fire.reason !== "cron_due" || !fire.occurrenceAtIso) {
    return `expected pre-DST cron_due with occurrenceAtIso, saw ${JSON.stringify(fire)}`;
  }
  const { hm, day } = localHourMinuteDay(fire.occurrenceAtIso, DST_TZ);
  if (hm !== "08:00") {
    return `pre-DST occurrence drifted from 08:00 local: ${fire.occurrenceAtIso} is ${hm} in ${DST_TZ}`;
  }
  if (day !== "31") {
    return `expected the pre-DST occurrence on Oct 31, saw local day ${day} (${fire.occurrenceAtIso})`;
  }
  // Pre-DST is EDT (UTC-4): 08:00 local is 12:00Z.
  if (!fire.occurrenceAtIso.startsWith("2026-10-31T12:00")) {
    return `expected pre-DST occurrence at 12:00Z (08:00 EDT) on Oct 31, saw ${fire.occurrenceAtIso}`;
  }
  return undefined;
}

function assertPostDst(_status: number, body: unknown): string | undefined {
  const fire = dailyFire(body);
  if (typeof fire === "string") return fire;
  if (fire.reason !== "cron_due" || !fire.occurrenceAtIso) {
    return `expected post-DST cron_due with occurrenceAtIso, saw ${JSON.stringify(fire)}`;
  }
  const { hm, day } = localHourMinuteDay(fire.occurrenceAtIso, DST_TZ);
  // Local time integrity: STILL 08:00 local, not 07:00, despite the offset flip.
  if (hm !== "08:00") {
    return `post-DST occurrence drifted from 08:00 local: ${fire.occurrenceAtIso} is ${hm} in ${DST_TZ} — DST was not honored`;
  }
  if (day !== "01") {
    return `expected the post-DST occurrence on Nov 01, saw local day ${day} (${fire.occurrenceAtIso})`;
  }
  // Post-DST is EST (UTC-5): 08:00 local is 13:00Z — an hour later in UTC than
  // the pre-DST occurrence, which is the whole point.
  if (!fire.occurrenceAtIso.startsWith("2026-11-01T13:00")) {
    return `expected post-DST occurrence at 13:00Z (08:00 EST) on Nov 01, saw ${fire.occurrenceAtIso}`;
  }
  return undefined;
}

export default scenario({
  // Literal (not the SCENARIO_ID const) so the static corpus guard can read it.
  id: "traveler-dst-boundary-reminder-integrity",
  lane: "pr-deterministic",
  title:
    "Traveler DST integrity: a daily 08:00 reminder keeps its local time across a fall-back transition",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "traveler",
    "timezone",
    "dst",
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
      name: "register the always-delivering probe channel",
      apply: seedChannel,
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elena Road DST" }],
  turns: [
    {
      kind: "api",
      name: "create a daily 08:00 America/New_York reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning check-in at 8am local",
        trigger: { kind: "cron", expression: "0 8 * * *", tz: DST_TZ },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-daily-dst`,
        metadata: { scenario: SCENARIO_ID, createdAtIso: CRON_BASE_ISO },
      },
      expectedStatus: 201,
      captures: { dailyTaskId: "task.taskId" },
      assertResponse: assertCreated,
    },
    {
      kind: "tick",
      name: "pre-DST tick (Oct 31) → fires at 08:00 EDT = 12:00Z",
      worker: "lifeops_scheduler",
      options: { now: PRE_DST_TICK, scheduledTaskLimit: 50 },
      assertResponse: assertPreDst,
    },
    {
      kind: "tick",
      name: "post-DST tick (Nov 02) → refires at 08:00 EST = 13:00Z, local time intact",
      worker: "lifeops_scheduler",
      options: { now: POST_DST_TICK, scheduledTaskLimit: 50 },
      assertResponse: assertPostDst,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly two deliveries, one per day, both 08:00 local across the DST boundary",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 2) {
          return `expected exactly 2 deliveries (pre-DST + post-DST), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
