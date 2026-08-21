/**
 * A2 adhd-follow-through (pr-deterministic). Deterministic ScheduledTask proof
 * that engagement STOPS the no-reply ladder: once Casey actually acknowledges a
 * fired reminder ("still on your plate?" -> "got it"), the escalation is retired
 * — a later tick produces no retry and no terminal timeout, because the task is
 * no longer in the `fired` state the completion-timeout pass scans. This is the
 * non-shaming other half of the ladder: chasing exists only while the owner is
 * silent, and disappears the instant they engage. Drives the REAL scheduler tick
 * (logical clock, no LLM, no key) and asserts STRUCTURAL outcomes on
 * `scheduledTaskFires[]` + `scheduledTaskCompletionTimeouts[]`. Maps to
 * LifeOpsBench live.adhd.follow.terse_reengagement_after_silence; the live judge
 * of the re-engagement wording stays on the bench surface.
 *
 * The reset is structural: `isCompletionTimeoutDue` only considers tasks whose
 * `state.status === "fired"`; the `acknowledge` verb transitions
 * `fired -> acknowledged`, so the very same tick that WOULD have produced a
 * `no_reply_retry_1` now produces nothing for this task. Contrast with
 * `adhd-followthrough-noreply-retry-then-skip`, where the identical silence
 * DOES escalate.
 *
 * Fail-without-fix anchor:
 *   - Make the completion-timeout pass in
 *     `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts`
 *     ignore the acknowledged state (scan acknowledged rows too) and the
 *     acknowledged reminder wrongly escalates — the "no escalation after
 *     acknowledge" turn fails because a `no_reply_retry_1` timeout appears.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-followthrough-reply-breaks-escalation";
const DELIVERY_CHANNEL_KIND = "scenario_a2_reply_break_delivery";
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

// Fires 09:00, followup 30m. Casey acknowledges at 09:20 (inside the window),
// so the 09:35 tick — which would otherwise escalate — sees no fired row.
const FIRE = futureDateAtUtc(9, 0, 8);
const PAST_TIMEOUT_TICK = futureDateAtUtc(9, 35, 8);

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
      describe: { label: "Scenario A2 reply-breaks-escalation delivery probe" },
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

  // Pin the DEFAULT ladder so a sibling intensity scenario can't reshape it —
  // the point here is engagement, not intensity.
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

function assertFiredOnce(_status: number, body: unknown): string | undefined {
  const fires = readList(body, "scheduledTaskFires");
  if (typeof fires === "string") return fires;
  const mine = forReminder(fires);
  if (typeof mine === "string") return mine;
  const fired = mine.filter((f) => f.status === "fired");
  if (fired.length !== 1 || fired[0]?.reason !== "once_due") {
    return `expected exactly one once_due fire, saw ${JSON.stringify(mine)}`;
  }
  return undefined;
}

// The acknowledge verb must move the reminder out of `fired`. Its response is
// `{ task }`; the acknowledged task carries state.status "acknowledged".
function assertAcknowledged(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response from acknowledge, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (task.taskId !== capturedTaskIds.reminder) {
    return `expected acknowledged task ${capturedTaskIds.reminder}, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "acknowledged") {
    return `expected acknowledged state, saw ${JSON.stringify(task.state)}`;
  }
  return undefined;
}

// The load-bearing assertion: past the followup window, an acknowledged
// reminder produces NO no-reply timeout and NO re-fire.
function assertNoEscalationAfterAck(
  _status: number,
  body: unknown,
): string | undefined {
  const timeouts = readList(body, "scheduledTaskCompletionTimeouts");
  if (typeof timeouts === "string") return timeouts;
  const fires = readList(body, "scheduledTaskFires");
  if (typeof fires === "string") return fires;
  const timeoutHits = forReminder(timeouts);
  if (typeof timeoutHits === "string") return timeoutHits;
  const fireHits = forReminder(fires);
  if (typeof fireHits === "string") return fireHits;
  if (timeoutHits.length !== 0) {
    return `acknowledged reminder must NOT escalate, saw timeouts ${JSON.stringify(timeoutHits)}`;
  }
  if (fireHits.length !== 0) {
    return `acknowledged reminder must NOT re-fire, saw fires ${JSON.stringify(fireHits)}`;
  }
  return undefined;
}

export default scenario({
  id: "adhd-followthrough-reply-breaks-escalation",
  lane: "pr-deterministic",
  title:
    "ADHD follow-through: acknowledging a reminder retires the no-reply ladder — chasing stops on engagement",
  domain: "lifeops",
  evidenceScope: "domain-contract",
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
      name: "register the delivery channel and pin normal intensity",
      apply: seedChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Follow-through reply breaks escalation",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the reminder with a no-reply completion check",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "call the pharmacy about the refill",
        trigger: { kind: "once", atIso: FIRE.toISOString() },
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
      // Capture the runtime taskId two ways: a scenario variable so the
      // acknowledge turn can template it into the REST path, and module state
      // so the tick readers can filter by it.
      captures: { reminderTaskId: "task.taskId" },
      assertResponse: captureReminderTaskId,
    },
    {
      kind: "tick",
      name: "fires once",
      worker: "lifeops_scheduler",
      options: { now: FIRE.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFiredOnce,
    },
    // Casey engages: she acknowledges the fired reminder.
    {
      kind: "api",
      name: "acknowledge the reminder (Casey replies)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:reminderTaskId}}/acknowledge",
      body: {},
      expectedStatus: 200,
      assertResponse: assertAcknowledged,
    },
    // Past the followup window: the ladder is retired — no retry, no re-fire.
    {
      kind: "tick",
      name: "tick past the followup window -> no escalation (engagement retired it)",
      worker: "lifeops_scheduler",
      options: { now: PAST_TIMEOUT_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertNoEscalationAfterAck,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "reminder was created, fired, and acknowledged",
      predicate: (): string | undefined =>
        capturedTaskIds.reminder === null
          ? "reminder taskId was never captured"
          : undefined,
    },
  ],
});
