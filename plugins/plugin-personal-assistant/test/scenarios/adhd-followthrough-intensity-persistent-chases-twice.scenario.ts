/**
 * A2 adhd-follow-through (pr-deterministic). Deterministic ScheduledTask proof
 * that a `persistent` owner `reminderIntensity` earns an EXTRA no-reply retry
 * rung: Casey asked to be chased harder on load-bearing tasks, so an ignored
 * reminder re-nudges TWICE (retry_1, retry_2) before settling — one more chase
 * than the default `normal` ladder in the sibling retry-then-skip scenario.
 * Drives the REAL scheduler tick (logical clock, no LLM, no key) and asserts the
 * STRUCTURAL two-rung progression on `scheduledTaskCompletionTimeouts[]` +
 * `scheduledTaskFires[]`. Maps to LifeOpsBench
 * live.adhd.follow.accountability_without_surveillance (chase me, but bounded);
 * the live judge of the wording stays on the bench surface.
 *
 * The intensity transform is pure and unit-covered
 * (`no-reply-intensity.ts::applyReminderIntensityToNoReplyPolicy`): from the
 * default reminder policy `{maxRetries:1, cadence:[60]}`, `persistent` yields
 * `{maxRetries:2, cadence:[60,60]}`. The owner fact is set once in the seed via
 * the REAL OwnerFactStore (`setReminderIntensity`), so intensity — not the task
 * shape — drives the difference.
 *
 * Read against the sibling `adhd-followthrough-noreply-retry-then-skip` (normal,
 * ONE retry rung) and `adhd-followthrough-intensity-minimal-chases-none`
 * (minimal, ZERO retry rungs) this triple pins the whole intensity axis.
 *
 * Fail-without-fix anchor:
 *   - Revert the `persistent` branch in
 *     `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/no-reply-intensity.ts`
 *     (drop the `maxRetries + 1` / trailing-cadence append) and the reminder
 *     settles terminally after retry_1 — the "retry_2" turn fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-followthrough-intensity-persistent-chases-twice";
const DELIVERY_CHANNEL_KIND = "scenario_a2_persistent_delivery";
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

// persistent = {maxRetries:2, cadence:[60,60]}. Fires 09:00, followup 30m.
//  09:35 -> retry_1 (snooze 10:35), 10:40 -> re-fire, 11:15 -> retry_2
//  (snooze 12:15), 12:20 -> re-fire, 12:55 -> terminal skip.
const FIRE = futureDateAtUtc(9, 0, 6);
const TIMEOUT_1 = futureDateAtUtc(9, 35, 6);
const REFIRE_1 = futureDateAtUtc(10, 40, 6);
const TIMEOUT_2 = futureDateAtUtc(11, 15, 6);
const REFIRE_2 = futureDateAtUtc(12, 20, 6);
const TERMINAL = futureDateAtUtc(12, 55, 6);

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

async function seedPersistentIntensityAndChannel(
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
      describe: { label: "Scenario A2 persistent-intensity delivery probe" },
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
    { intensity: "persistent" },
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

function assertFired(
  reason: string,
): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const fires = readList(body, "scheduledTaskFires");
    if (typeof fires === "string") return fires;
    const mine = forReminder(fires);
    if (typeof mine === "string") return mine;
    const fired = mine.filter((f) => f.status === "fired");
    if (fired.length !== 1 || fired[0]?.reason !== reason) {
      return `expected exactly one fire reason "${reason}", saw ${JSON.stringify(mine)}`;
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
      return `expected exactly one completion timeout, saw ${JSON.stringify(mine)}`;
    }
    const t = mine[0];
    if (t?.status !== expectedStatus || t.reason !== expectedReason) {
      return `expected timeout {status:${expectedStatus}, reason:${expectedReason}}, saw ${JSON.stringify(t)}`;
    }
    return undefined;
  };
}

export default scenario({
  id: "adhd-followthrough-intensity-persistent-chases-twice",
  lane: "pr-deterministic",
  title:
    "ADHD follow-through: persistent reminderIntensity earns a second no-reply retry rung",
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
      name: "set owner reminderIntensity=persistent and register the delivery channel",
      apply: seedPersistentIntensityAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Follow-through persistent",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the reminder (persistent intensity is owner-wide)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "submit the reimbursement before the quarter closes",
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
      assertResponse: assertFired("once_due"),
    },
    {
      kind: "tick",
      name: "first silence -> retry_1",
      worker: "lifeops_scheduler",
      options: { now: TIMEOUT_1.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTimeout("scheduled", "no_reply_retry_1"),
    },
    {
      kind: "tick",
      name: "retry_1 override re-fires",
      worker: "lifeops_scheduler",
      options: { now: REFIRE_1.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFired("scheduled_override_due"),
    },
    {
      kind: "tick",
      name: "second silence -> retry_2 (the extra rung persistent earns)",
      worker: "lifeops_scheduler",
      options: { now: TIMEOUT_2.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTimeout("scheduled", "no_reply_retry_2"),
    },
    {
      kind: "tick",
      name: "retry_2 override re-fires",
      worker: "lifeops_scheduler",
      options: { now: REFIRE_2.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFired("scheduled_override_due"),
    },
    {
      kind: "tick",
      name: "still ignored past both rungs -> terminal skip",
      worker: "lifeops_scheduler",
      options: { now: TERMINAL.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertTimeout("skipped", "no_reply_reminder_expired"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "persistent reminder was created and driven through both rungs",
      predicate: (): string | undefined =>
        capturedTaskIds.reminder === null
          ? "reminder taskId was never captured"
          : undefined,
    },
  ],
});
