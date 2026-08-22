/**
 * A2 adhd-follow-through (pr-deterministic). Deterministic ScheduledTask proof
 * that a `minimal` owner `reminderIntensity` DROPS the no-reply retry rung
 * entirely: Casey, mid-burnout, has told the assistant to stop chasing her, so
 * an ignored reminder fires ONCE and then settles terminally with no re-nudge —
 * the anti-nag end of the intensity axis. Drives the REAL scheduler tick
 * (logical clock, no LLM, no key) and asserts the STRUCTURAL "no retry rung,
 * terminal at the first timeout" outcome on
 * `scheduledTaskCompletionTimeouts[]`. Maps to LifeOpsBench
 * live.adhd.follow.repeated_miss_shrink_or_pause (stop chasing a drowning
 * owner); the live judge of the non-shaming wording stays on the bench surface.
 *
 * The intensity transform is pure and unit-covered
 * (`no-reply-intensity.ts::applyReminderIntensityToNoReplyPolicy`): `minimal`
 * yields `{maxRetries:0, cadence:[]}`, so the FIRST completion timeout is
 * terminal — no `no_reply_retry_1`. The owner fact is set once in the seed via
 * the REAL OwnerFactStore (`setReminderIntensity`).
 *
 * Read against `adhd-followthrough-noreply-retry-then-skip` (normal, ONE rung)
 * and `adhd-followthrough-intensity-persistent-chases-twice` (persistent, TWO
 * rungs) this pins the low end of the intensity axis.
 *
 * Fail-without-fix anchor:
 *   - Revert the `minimal` branch in
 *     `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/no-reply-intensity.ts`
 *     (stop zeroing maxRetries/cadence) and the reminder earns a retry_1 rung —
 *     the "terminal at the first timeout, no retry" turn fails because a
 *     `no_reply_retry_1` timeout appears instead.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-followthrough-intensity-minimal-chases-none";
const DELIVERY_CHANNEL_KIND = "scenario_a2_minimal_delivery";
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

// minimal = {maxRetries:0, cadence:[]}. Fires 09:00, followup 30m; the FIRST
// timeout (09:35) is terminal — there is no retry rung and no re-fire.
const FIRE = futureDateAtUtc(9, 0, 7);
const TERMINAL = futureDateAtUtc(9, 35, 7);
const AFTER = futureDateAtUtc(11, 0, 7);

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

async function seedMinimalIntensityAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  capturedTaskIds.reminder = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario A2 minimal-intensity delivery probe" },
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

  const mod = await import("@elizaos/plugin-personal-assistant/plugin");
  const store = (
    mod as { resolveOwnerFactStore: (rt: unknown) => OwnerFactStoreLike }
  ).resolveOwnerFactStore(ctx.runtime);
  await store.setReminderIntensity(
    { intensity: "minimal" },
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

// The minimal ladder's signature: the FIRST timeout is terminal, and it is a
// skip (not a retry). A retry_1 here would mean the minimal branch regressed.
function assertTerminalNoRetry(
  _status: number,
  body: unknown,
): string | undefined {
  const timeouts = readList(body, "scheduledTaskCompletionTimeouts");
  if (typeof timeouts === "string") return timeouts;
  const mine = forReminder(timeouts);
  if (typeof mine === "string") return mine;
  if (mine.length !== 1) {
    return `expected exactly one completion timeout, saw ${JSON.stringify(mine)}`;
  }
  const t = mine[0];
  if (t?.reason === "no_reply_retry_1" || t?.status === "scheduled") {
    return `minimal must NOT earn a retry rung, saw ${JSON.stringify(t)}`;
  }
  if (t?.status !== "skipped" || t.reason !== "no_reply_reminder_expired") {
    return `expected terminal {status:skipped, reason:no_reply_reminder_expired}, saw ${JSON.stringify(t)}`;
  }
  return undefined;
}

// After the terminal skip, no override re-arms — a later tick surfaces nothing
// for this task (neither a fire nor another timeout).
function assertQuietAfterTerminal(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = readList(body, "scheduledTaskFires");
  if (typeof fires === "string") return fires;
  const timeouts = readList(body, "scheduledTaskCompletionTimeouts");
  if (typeof timeouts === "string") return timeouts;
  const fireHits = forReminder(fires);
  if (typeof fireHits === "string") return fireHits;
  const timeoutHits = forReminder(timeouts);
  if (typeof timeoutHits === "string") return timeoutHits;
  if (fireHits.length !== 0 || timeoutHits.length !== 0) {
    return `expected no activity for the terminal reminder, saw fires=${JSON.stringify(fireHits)} timeouts=${JSON.stringify(timeoutHits)}`;
  }
  return undefined;
}

export default scenario({
  id: "adhd-followthrough-intensity-minimal-chases-none",
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
        cardinality: 1,
      },
    ],
  },
  title:
    "ADHD follow-through: minimal reminderIntensity drops the no-reply retry entirely — fires once, then stops",
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
    "reminder-intensity",
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
      name: "set owner reminderIntensity=minimal and register the delivery channel",
      apply: seedMinimalIntensityAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Follow-through minimal",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the reminder (minimal intensity is owner-wide)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "water the plants sometime today",
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
      assertResponse: captureReminderTaskId,
    },
    {
      kind: "tick",
      name: "fires once",
      worker: "lifeops_scheduler",
      options: { now: FIRE.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFiredOnce,
    },
    {
      kind: "tick",
      name: "first silence -> terminal skip, NO retry rung",
      worker: "lifeops_scheduler",
      options: { now: TERMINAL.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTerminalNoRetry,
    },
    {
      kind: "tick",
      name: "later tick -> nothing re-arms (fires once, then truly stops)",
      worker: "lifeops_scheduler",
      options: { now: AFTER.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertQuietAfterTerminal,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "minimal reminder was created and settled without a retry",
      predicate: (): string | undefined =>
        capturedTaskIds.reminder === null
          ? "reminder taskId was never captured"
          : undefined,
    },
  ],
});
