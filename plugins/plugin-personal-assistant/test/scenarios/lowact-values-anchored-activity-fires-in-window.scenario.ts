/**
 * E1 low-activation-reengagement (pr-deterministic). Deterministic ScheduledTask
 * proof for a values-anchored activity that respects the owner's real rhythm: a
 * `during_window` reminder tied to a low-activation-friendly evening pick fires
 * INSIDE the owner's seeded evening window and DEFERS outside it — the gentle
 * "do one thing you care about" nudge lands when the owner is actually around,
 * never at a rigid wall-clock time. Drives the REAL scheduler tick (logical
 * clock, no LLM, no key) and asserts STRUCTURAL outcomes (fires in-window,
 * defers out-of-window), not routing. Maps to LifeOpsBench
 * lowact.values_anchored_activity_capture; the live conversational judge of the
 * values framing stays on the bench LIVE surface.
 *
 * Owner facts (timezone, eveningWindow) are seeded through the REAL
 * OwnerFactStore — the same read the `during_window` resolver uses. Tasks are
 * created through the REAL REST surface. Delivery goes through a
 * scenario-registered always-delivering channel. Run keyless with `TZ=UTC` so
 * window math is unambiguous.
 *
 * NO crisis guard is asserted (ordinary flexible scheduling; #12780 not-planned).
 *
 * Fail-without-fix anchor:
 *   - Revert the `during_window` bounds resolution in
 *     `plugins/plugin-scheduling/src/scheduled-task/due.ts`
 *     (`windowBoundsMinutes` / `windowOccurrenceKey`) so the window no longer
 *     tracks the owner's `eveningWindow` fact, and either the in-window tick
 *     stops firing or the out-of-window tick starts firing — both turns fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "lowact-values-anchored-activity-fires-in-window";
const DELIVERY_CHANNEL_KIND = "scenario_values_window_delivery";

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

// eveningWindow = 18:00–22:00. Fires at 20:00 (inside); defers at 23:00 (after).
const INSIDE_EVENING_TICK = futureDateAtUtc(20, 0, 2);
const AFTER_EVENING_TICK = futureDateAtUtc(23, 0, 2);

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
const capturedTaskIds: { activity: string | null } = { activity: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.activity = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario values-anchored window delivery probe" },
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
      timezone: "UTC",
      morningWindow: { startLocal: "09:00", endLocal: "12:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
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

function firesForActivity(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (typeof capturedTaskIds.activity !== "string") {
    return "activity taskId was not set by the create turn";
  }
  return fires.filter((fire) => fire.taskId === capturedTaskIds.activity);
}

function captureActivityId(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  capturedTaskIds.activity = task.taskId;
  return undefined;
}

function firedInWindow(_status: number, body: unknown): string | undefined {
  const fires = firesForActivity(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1 || fires[0]?.status !== "fired") {
    return `expected the values activity to fire once inside the evening window, saw ${JSON.stringify(fires)}`;
  }
  return undefined;
}

function deferredOutOfWindow(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = firesForActivity(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `the values activity must NOT fire outside the evening window, saw ${JSON.stringify(fired)}`;
  }
  return undefined;
}

export default scenario({
  id: "lowact-values-anchored-activity-fires-in-window",
  lane: "pr-deterministic",
  title:
    "Low activation: a values-anchored activity fires inside the owner's evening window, defers outside it",
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
      name: "seed owner facts (evening window) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create a during_window values-anchored evening activity",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "one thing that matters to you tonight — a few minutes with the guitar",
        trigger: { kind: "during_window", windowKey: "evening" },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-values-activity`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureActivityId,
    },
    {
      kind: "tick",
      name: "tick after the evening window (23:00) → activity defers, no fire",
      worker: "lifeops_scheduler",
      options: {
        now: AFTER_EVENING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: deferredOutOfWindow,
    },
    {
      kind: "tick",
      name: "tick inside the evening window (20:00) → activity fires once",
      worker: "lifeops_scheduler",
      options: {
        now: INSIDE_EVENING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: firedInWindow,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the in-window evening activity",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the in-window activity), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
