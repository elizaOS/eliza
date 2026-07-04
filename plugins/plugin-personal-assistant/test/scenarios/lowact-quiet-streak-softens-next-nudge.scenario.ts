/**
 * E1 low-activation-reengagement (pr-deterministic). Deterministic ScheduledTask
 * proof for the quiet-streak softening (#12779/#13237): after the owner has
 * ignored three consecutive check-ins, the next reminder that times out is
 * softened one intensity notch DOWN (normal → minimal) instead of earning a
 * fresh 60-minute re-poke — a silent, low-activation owner is never chased
 * harder or streak-shamed. Drives the REAL scheduler tick (logical clock, no
 * LLM, no key) and asserts STRUCTURAL outcomes read back off the persisted task
 * (`noReplyState.quietStreakSoftened` + the emptied retry ladder), not routing.
 *
 * The streak is built the honest way: three check-ins are created through the
 * REAL REST surface and driven to fire + terminally expire through REAL ticks,
 * so the production recent-task-states log writer (`recordTaskStateEntry`) lays
 * down the `checkin/expired` streak the quiet-user watcher reads. No log entry
 * is hand-seeded. The softening decision (`quietStreakDaysFromObservations` ≥
 * `QUIET_THRESHOLD_DAYS` → `softenReminderIntensityForQuietStreak`) is exactly
 * the one the unit suite exercises
 * (`scheduler.quiet-streak.test.ts`), proven here end to end on the keyless
 * scenario runtime.
 *
 * Absolute UTC instants keep the proof independent of host timezone; all ticks
 * are far in the future so only the injected `now` decides dueness. Run keyless
 * with `TZ=UTC`.
 *
 * NO crisis guard is asserted anywhere — the softening is the ordinary,
 * non-judgmental no-reply behavior (#12780 crisis guard is not-planned).
 *
 * Fail-without-fix anchor:
 *   - Revert `softenReminderIntensityForQuietStreak` /
 *     `resolveQuietStreakDays` in
 *     `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts`
 *     (and `no-reply-intensity.ts`) so the streak no longer steps intensity
 *     down, and the timed-out reminder re-arms a 60-minute retry instead of
 *     settling terminally — the softened-ladder finalCheck fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "lowact-quiet-streak-softens-next-nudge";
const DELIVERY_CHANNEL_KIND = "scenario_quiet_streak_delivery";

const DAY_MS = 24 * 60 * 60 * 1000;

function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

// Three ignored check-ins on three consecutive days, then a fourth-day reminder
// that times out. All within the watcher's 7-day lookback so the streak counts.
const CHECKIN_FIRE = [
  futureDateAtUtc(8, 0, 2),
  futureDateAtUtc(8, 0, 3),
  futureDateAtUtc(8, 0, 4),
];
// A check-in expires 61 minutes after firing (followupAfterMinutes: 60).
const CHECKIN_EXPIRE = CHECKIN_FIRE.map(
  (fire) => new Date(fire.getTime() + 61 * 60 * 1000),
);
const REMINDER_FIRE = futureDateAtUtc(8, 0, 5);
const REMINDER_TIMEOUT = new Date(REMINDER_FIRE.getTime() + 31 * 60 * 1000);

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

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const deliveryLedger: unknown[] = [];
const capturedTaskIds: { reminder: string | null } = { reminder: null };

async function seedChannel(ctx: ScenarioContext): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.reminder = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario quiet-streak delivery probe" },
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

function readTimeouts(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskCompletionTimeouts;
  if (!Array.isArray(raw)) {
    return "expected scheduledTaskCompletionTimeouts array";
  }
  const timeouts: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string"
    ) {
      return `malformed timeout entry: ${JSON.stringify(entry)}`;
    }
    timeouts.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    });
  }
  return timeouts;
}

function captureReminderId(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  capturedTaskIds.reminder = task.taskId;
  return undefined;
}

/**
 * After the streak-building ticks, the reminder that times out must settle
 * TERMINALLY (`skipped`) — the softened `minimal` intensity drops all retries —
 * rather than re-arm a `no_reply_retry_*` fire. Asserted on the tick's
 * completion-timeout record.
 */
function reminderSoftenedToTerminal(
  _status: number,
  body: unknown,
): string | undefined {
  const timeouts = readTimeouts(body);
  if (typeof timeouts === "string") return timeouts;
  if (typeof capturedTaskIds.reminder !== "string") {
    return "reminder taskId was not captured";
  }
  const mine = timeouts.filter((t) => t.taskId === capturedTaskIds.reminder);
  if (mine.length !== 1) {
    return `expected exactly one timeout for the reminder, saw ${JSON.stringify(mine)}`;
  }
  const entry = mine[0];
  if (entry?.status !== "skipped") {
    return `expected the softened reminder to settle terminally (skipped), saw ${JSON.stringify(entry)}`;
  }
  if (entry.reason.startsWith("no_reply_retry")) {
    return `softened reminder must NOT re-arm a retry, saw reason ${entry.reason}`;
  }
  return undefined;
}

/**
 * Read the persisted reminder back off the REAL list surface and prove the
 * softening is recorded structurally: the no-reply ladder is emptied and the
 * decision is stamped `quietStreakSoftened` with the softened intensity.
 */
function assertSoftenedRecord(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.tasks)) {
    return `expected {tasks[]} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.tasks.find(
    (t) => isRecord(t) && t.taskId === capturedTaskIds.reminder,
  );
  if (!isRecord(task)) {
    return `reminder ${capturedTaskIds.reminder} not found in list`;
  }
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const noReplyPolicy = isRecord(metadata?.noReplyPolicy)
    ? metadata.noReplyPolicy
    : null;
  const noReplyState = isRecord(metadata?.noReplyState)
    ? metadata.noReplyState
    : null;
  if (noReplyPolicy?.maxRetries !== 0) {
    return `expected the softened policy to drop retries (maxRetries 0), saw ${JSON.stringify(noReplyPolicy)}`;
  }
  if (
    Array.isArray(noReplyPolicy?.retryCadenceMinutes) &&
    noReplyPolicy.retryCadenceMinutes.length !== 0
  ) {
    return `expected an empty retry cadence, saw ${JSON.stringify(noReplyPolicy.retryCadenceMinutes)}`;
  }
  if (noReplyState?.quietStreakSoftened !== true) {
    return `expected quietStreakSoftened=true, saw ${JSON.stringify(noReplyState)}`;
  }
  if (
    typeof noReplyState.quietStreakDays !== "number" ||
    noReplyState.quietStreakDays < 3
  ) {
    return `expected quietStreakDays >= 3, saw ${JSON.stringify(noReplyState.quietStreakDays)}`;
  }
  if (noReplyState.appliedReminderIntensity !== "minimal") {
    return `expected softened intensity 'minimal', saw ${JSON.stringify(noReplyState.appliedReminderIntensity)}`;
  }
  return undefined;
}

function checkinBody(dayIndex: number): JsonRecord {
  return {
    kind: "checkin",
    promptInstructions: "gentle check-in: how are you doing today?",
    trigger: { kind: "once", atIso: CHECKIN_FIRE[dayIndex]?.toISOString() },
    priority: "medium",
    completionCheck: {
      kind: "user_replied_within",
      followupAfterMinutes: 60,
    },
    output: {
      destination: "channel",
      target: `${DELIVERY_CHANNEL_KIND}:owner`,
    },
    respectsGlobalPause: false,
    source: "default_pack",
    createdBy: SCENARIO_ID,
    ownerVisible: true,
    idempotencyKey: `${SCENARIO_ID}-checkin-${dayIndex}`,
    metadata: {
      scenario: SCENARIO_ID,
      noReplyPolicy: {
        maxRetries: 0,
        terminalStatus: "expired",
        terminalReason: "no_reply_checkin_expired",
      },
    },
  };
}

function createCheckinTurn(dayIndex: number) {
  return {
    kind: "api" as const,
    name: `create ignored check-in ${dayIndex + 1}`,
    method: "POST" as const,
    path: "/api/lifeops/scheduled-tasks",
    body: checkinBody(dayIndex),
    expectedStatus: 201,
  };
}

function fireCheckinTurn(dayIndex: number) {
  return {
    kind: "tick" as const,
    name: `tick: check-in ${dayIndex + 1} fires`,
    worker: "lifeops_scheduler" as const,
    options: {
      now: CHECKIN_FIRE[dayIndex]?.toISOString(),
      scheduledTaskLimit: 50,
    },
  };
}

function expireCheckinTurn(dayIndex: number) {
  return {
    kind: "tick" as const,
    name: `tick: check-in ${dayIndex + 1} expires unanswered`,
    worker: "lifeops_scheduler" as const,
    options: {
      now: CHECKIN_EXPIRE[dayIndex]?.toISOString(),
      scheduledTaskLimit: 50,
    },
  };
}

export default scenario({
  id: "lowact-quiet-streak-softens-next-nudge",
  lane: "pr-deterministic",
  title:
    "Low activation: three ignored check-ins soften the next nudge (quiet-streak), never chase harder",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "low-activation",
    "personas",
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
      name: "register delivery channel and reset captured task-id state",
      apply: seedChannel,
    },
  ],
  turns: [
    // Build a 3-day ignored-checkin streak through the REAL fire/expire path.
    createCheckinTurn(0),
    fireCheckinTurn(0),
    expireCheckinTurn(0),
    createCheckinTurn(1),
    fireCheckinTurn(1),
    expireCheckinTurn(1),
    createCheckinTurn(2),
    fireCheckinTurn(2),
    expireCheckinTurn(2),
    // A fourth-day reminder fires and then times out. Its no-reply ladder is
    // selected under the softened intensity because the streak is now 3.
    {
      kind: "api",
      name: "create the next reminder (would normally earn a 60-minute re-poke)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "one small thing today — stretch for five minutes",
        trigger: { kind: "once", atIso: REMINDER_FIRE.toISOString() },
        priority: "medium",
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 30,
        },
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-reminder`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureReminderId,
    },
    {
      kind: "tick",
      name: "tick: the reminder fires",
      worker: "lifeops_scheduler",
      options: { now: REMINDER_FIRE.toISOString(), scheduledTaskLimit: 50 },
    },
    {
      kind: "tick",
      name: "tick: the reminder times out → quiet streak softens it to terminal",
      worker: "lifeops_scheduler",
      options: { now: REMINDER_TIMEOUT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: reminderSoftenedToTerminal,
    },
    // Read the persisted record: the softening is structural + observable.
    {
      kind: "api",
      name: "read the reminder back — softening is recorded on the task",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertSoftenedRecord,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the reminder settled terminally under quiet-streak softening",
      predicate: (): string | undefined => {
        if (capturedTaskIds.reminder === null) {
          return "reminder task was never created";
        }
        return undefined;
      },
    },
  ],
});
