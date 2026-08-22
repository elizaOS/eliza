/**
 * A2 adhd-follow-through (pr-deterministic). Deterministic ScheduledTask proof
 * for the ADHD dropped-task no-reply ladder: a reminder Casey never answers is
 * NOT silently lost and NOT nagged forever — it re-nudges exactly once, then
 * settles terminally. Drives the REAL scheduler tick (logical clock, no LLM, no
 * key) and asserts the STRUCTURAL retry -> re-fire -> terminal-skip progression
 * on `scheduledTaskCompletionTimeouts[]` + `scheduledTaskFires[]`, not routing.
 * Maps to LifeOpsBench live.adhd.follow.followup_watcher_after_nonreply; the
 * live conversational judge of the re-engagement wording stays on the bench LIVE
 * surface.
 *
 * The default reminder no-reply policy is `{ maxRetries: 1, retryCadence: [60],
 * terminal: skipped/no_reply_reminder_expired }` (owner `reminderIntensity`
 * unset => `normal` => unchanged). The ladder is completion-timeout driven: the
 * fire arms a `user_acknowledged` completion check with `followupAfterMinutes`,
 * and a later tick past `firedAt + followupAfterMinutes` with no acknowledgement
 * enters the ladder. A reply/ack would break it (proved in the sibling
 * reply-breaks-escalation scenario).
 *
 * Tasks are created through the REAL REST surface; ticks are the REAL scheduler
 * entry. Absolute future instants keep the proof independent of host timezone.
 *
 * Fail-without-fix anchor:
 *   - Revert the retry branch in
 *     `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts`
 *     `handleCompletionTimeout` (snooze override to `nextRetryAt`) and the
 *     ignored reminder either settles terminally on the FIRST timeout (the
 *     "retry_1" turn fails) or never re-fires (the override re-fire turn fails).
 *   - Break the terminal transition and the reminder re-nudges forever (the
 *     "terminal skip" turn fails).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-followthrough-noreply-retry-then-skip";
const DELIVERY_CHANNEL_KIND = "scenario_a2_noreply_retry_delivery";
const FOLLOWUP_MINUTES = 30;

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

// The reminder fires at 09:00. The completion check follows up 30m later, so:
//  - 09:35 (past 09:00+30) with no ack  -> no_reply_retry_1 (snooze to 10:35)
//  - 10:40 (past the 60m retry cadence) -> the override re-fires
//  - 11:15 (past 10:40+30) still no ack -> terminal skip
const FIRE_INSTANT = futureDateAtUtc(9, 0, 3);
const TIMEOUT_TICK = futureDateAtUtc(9, 35, 3);
const REFIRE_TICK = futureDateAtUtc(10, 40, 3);
const TERMINAL_TICK = futureDateAtUtc(11, 15, 3);

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

interface OwnerFactStoreLike {
  setReminderIntensity(
    patch: { intensity: string; note?: string },
    provenance: { source: string; recordedAt: string; note?: string },
  ): Promise<unknown>;
}

interface RuntimeLike {
  channelRegistry?: ChannelRegistryLike;
}

const capturedTaskIds: { reminder: string | null } = { reminder: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedChannel(ctx: ScenarioContext): Promise<string | undefined> {
  capturedTaskIds.reminder = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario A2 no-reply retry delivery probe" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(): Promise<{ ok: true; messageId: string }> {
        return { ok: true, messageId: `${SCENARIO_ID}-delivered` };
      },
    });
  }

  // Pin the DEFAULT ladder explicitly: the pr-deterministic lane shares one
  // runtime, so a sibling intensity scenario could otherwise leave the owner
  // fact set to persistent/minimal and reshape this reminder's ladder.
  const mod = await import("@elizaos/plugin-personal-assistant/plugin");
  const store = (
    mod as { resolveOwnerFactStore: (rt: unknown) => OwnerFactStoreLike }
  ).resolveOwnerFactStore(ctx.runtime);
  await store.setReminderIntensity(
    { intensity: "normal" },
    { source: "policy_action", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
}

function readList(
  body: unknown,
  key: "scheduledTaskFires" | "scheduledTaskCompletionTimeouts",
): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body[key];
  if (!Array.isArray(raw)) return `expected ${key} array`;
  const out: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed ${key} entry: ${JSON.stringify(entry)}`;
    }
    out.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
    });
  }
  return out;
}

function forReminder(entries: FireEntry[]): FireEntry[] | string {
  if (typeof capturedTaskIds.reminder !== "string") {
    return "captured reminder taskId was not set by the create turn";
  }
  return entries.filter((e) => e.taskId === capturedTaskIds.reminder);
}

function captureReminderTaskId(
  _status: number,
  body: unknown,
): string | undefined {
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

function assertFiredOnce(
  reason: string,
): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const fires = readList(body, "scheduledTaskFires");
    if (typeof fires === "string") return fires;
    const mine = forReminder(fires);
    if (typeof mine === "string") return mine;
    const fired = mine.filter((f) => f.status === "fired");
    if (fired.length !== 1) {
      return `expected exactly one fire for the reminder, saw ${JSON.stringify(mine)}`;
    }
    if (fired[0]?.reason !== reason) {
      return `expected fire reason "${reason}", saw "${fired[0]?.reason}"`;
    }
    return undefined;
  };
}

function assertTimeout(
  expectedStatus: string,
  expectedReason: string,
): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const timeouts = readList(body, "scheduledTaskCompletionTimeouts");
    if (typeof timeouts === "string") return timeouts;
    const mine = forReminder(timeouts);
    if (typeof mine === "string") return mine;
    if (mine.length !== 1) {
      return `expected exactly one completion timeout for the reminder, saw ${JSON.stringify(mine)}`;
    }
    const t = mine[0];
    if (t?.status !== expectedStatus || t.reason !== expectedReason) {
      return `expected timeout {status:${expectedStatus}, reason:${expectedReason}}, saw ${JSON.stringify(t)}`;
    }
    // The retry is the SNOOZE override — the reminder is neither lost nor
    // terminal at the retry rung.
    return undefined;
  };
}

export default scenario({
  id: "adhd-followthrough-noreply-retry-then-skip",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "dispatch-body",
        match: {
          modelType: "TEXT_SMALL",
          prompt: { includes: "\nInstruction:\n" },
        },
        response: { text: "Heads up: you have an update from your assistant." },
        cardinality: 2,
      },
    ],
  },
  title:
    "ADHD follow-through: an ignored reminder re-nudges once, then settles — never lost, never nagged forever",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "adhd",
    "personas",
    "scheduled-tasks",
    "escalation",
    "no-reply",
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
      name: "register the delivery channel",
      apply: seedChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Follow-through no-reply",
    },
  ],
  turns: [
    // Casey captures a load-bearing reminder with a no-reply completion check.
    {
      kind: "api",
      name: "create the reminder with a no-reply completion check",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "send the signed lease renewal back to the landlord",
        trigger: { kind: "once", atIso: FIRE_INSTANT.toISOString() },
        priority: "medium",
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: FOLLOWUP_MINUTES,
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
      assertResponse: captureReminderTaskId,
    },
    // 09:00 — the reminder fires; Casey does not reply.
    {
      kind: "tick",
      name: "tick at fire instant -> reminder fires once",
      worker: "lifeops_scheduler",
      options: { now: FIRE_INSTANT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFiredOnce("once_due"),
    },
    // 09:35 — 30m of silence: the ladder re-nudges, it is NOT dropped.
    {
      kind: "tick",
      name: "tick after silence -> no_reply_retry_1 (re-nudge, not lost)",
      worker: "lifeops_scheduler",
      options: { now: TIMEOUT_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTimeout("scheduled", "no_reply_retry_1"),
    },
    // 10:40 — the retry override comes due: the reminder re-fires.
    {
      kind: "tick",
      name: "tick after the retry cadence -> reminder re-fires via override",
      worker: "lifeops_scheduler",
      options: { now: REFIRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFiredOnce("scheduled_override_due"),
    },
    // 11:15 — still ignored past the retry budget: settle terminally, stop.
    {
      kind: "tick",
      name: "tick after the re-fire is ignored -> terminal skip, stops nagging",
      worker: "lifeops_scheduler",
      options: { now: TERMINAL_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTimeout("skipped", "no_reply_reminder_expired"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the ignored reminder ended terminally skipped, not still scheduled",
      predicate: (): string | undefined =>
        capturedTaskIds.reminder === null
          ? "reminder taskId was never captured"
          : undefined,
    },
  ],
});
