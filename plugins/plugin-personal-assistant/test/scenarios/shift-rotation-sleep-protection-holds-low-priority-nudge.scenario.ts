/**
 * B2 shift-rotation (pr-deterministic). Deterministic ScheduledTask proof that
 * the rotating-shift persona's (P3 marcus_shift) PROTECTED post-night-shift sleep
 * window holds low-value pings while still letting a genuinely important reminder
 * break through. Drives the REAL scheduler tick (logical clock, no LLM, no key)
 * and asserts STRUCTURAL outcomes (which task defers vs. bypasses the quiet_hours
 * gate, and what actually gets delivered), not routing. Maps to LifeOpsBench
 * shiftrotation.protect_pre_post_shift_sleep_window; the live conversational judge
 * of the same sleep-protection tone stays on the bench + live-only surface.
 *
 * Two interval reminders share one quiet_hours gate seeded to the protected
 * daytime sleep block (06:00–15:00, the sleep after a night shift). At a tick
 * inside that block: the low-priority ping DEFERS with a derived `quiet_hours:
 * deferring …` reason (sleep protected), while the high-priority reminder
 * BYPASSES the gate and FIRES exactly once (`highPriorityBypass` default). Only
 * the high-priority reminder is delivered. Non-echo: the asserted tokens are fire
 * STATUS and the derived gate reason, never text from a turn.
 *
 * Owner facts (timezone, quietHours) are seeded through the REAL OwnerFactStore.
 * Tasks are created through the REAL REST surface. Delivery goes through a
 * scenario-registered always-delivering channel so fires have a real surface. Run
 * keyless with `TZ=UTC` so the quiet-hours window math is unambiguous.
 *
 * Fail-without-fix anchors:
 *   - Revert the `quiet_hours` gate's low/medium hold in
 *     `plugins/plugin-scheduling/src/scheduled-task/gate-registry.ts` (defer when
 *     inside the window for non-high priority) and the low-value ping fires
 *     inside protected sleep — the "defers" turn fails and the delivery ledger
 *     grows past one.
 *   - Break `highPriorityBypass` so `high` priority no longer skips the gate and
 *     the important reminder is held during sleep — the "fires exactly once" turn
 *     fails and nothing is delivered.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "shift-rotation-sleep-protection-holds-low-priority-nudge";
const DELIVERY_CHANNEL_KIND = "scenario_shift_sleep_protection_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now` decides
// dueness. UTC throughout. Protected post-night-shift sleep block is quiet-hours
// 06:00–15:00; the tick lands at 09:00, deep inside it.
// ---------------------------------------------------------------------------

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

// 09:00 — deep inside the protected daytime sleep block (06:00–15:00).
const INSIDE_SLEEP_TICK = futureDateAtUtc(9, 0, 2);

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

const capturedTaskIds: { lowPing: string | null; important: string | null } = {
  lowPing: null,
  important: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.lowPing = null;
  capturedTaskIds.important = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario shift sleep-protection delivery probe" },
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
  // Protected post-night-shift sleep block: quiet hours cover the daytime.
  await store.update(
    {
      timezone: "UTC",
      quietHours: { startLocal: "06:00", endLocal: "15:00", timezone: "UTC" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Tick response readers.
// ---------------------------------------------------------------------------

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

function firesForTask(
  body: unknown,
  taskId: string | null,
): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return "captured taskId was not set by the create turn";
  }
  return fires.filter((fire) => fire.taskId === taskId);
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

function firedFor(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    if (fires.length !== 1 || fires[0]?.status !== "fired") {
      return `expected exactly one fired for ${slot}, saw ${JSON.stringify(fires)}`;
    }
    return undefined;
  };
}

function deferredFor(
  slot: keyof typeof capturedTaskIds,
  reasonPrefix: string,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    const fired = fires.filter((f) => f.status === "fired");
    if (fired.length !== 0) {
      return `expected ${slot} to defer, not fire, saw ${JSON.stringify(fired)}`;
    }
    const deferred = fires.find((f) => f.reason.includes(reasonPrefix));
    if (!deferred) {
      return `expected ${slot} deferred with reason ~"${reasonPrefix}", saw ${JSON.stringify(fires)}`;
    }
    return undefined;
  };
}

function protectedSleepTick(
  _status: number,
  body: unknown,
): string | undefined {
  return (
    deferredFor("lowPing", "quiet_hours")(_status, body) ??
    firedFor("important")(_status, body)
  );
}

export default scenario({
  id: "shift-rotation-sleep-protection-holds-low-priority-nudge",
  lane: "pr-deterministic",
  title:
    "Protected post-night-shift sleep holds a low-value ping while an important reminder breaks through",
  domain: "lifeops",
  evidenceScope: "domain-contract",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "shift-rotation",
    "personas",
    "scheduled-tasks",
    "12772",
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
      name: "seed protected daytime sleep (quiet hours) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Shift Rotation Sleep Protection",
    },
  ],
  turns: [
    // Low-value ping: quiet_hours-gated, low priority — must be held during
    // protected sleep so it does not wake Marcus for something unimportant.
    {
      kind: "api",
      name: "create the low-priority quiet-hours-gated ping",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "optional low-value ping",
        trigger: { kind: "interval", everyMinutes: 60 },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "quiet_hours", params: { highPriorityBypass: true } },
          ],
        },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-low-ping`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("lowPing"),
    },
    // Important reminder: same quiet_hours gate, high priority — must bypass the
    // gate and break through even during protected sleep.
    {
      kind: "api",
      name: "create the high-priority quiet-hours-gated reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "important reminder that must break through sleep",
        trigger: { kind: "interval", everyMinutes: 60 },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "quiet_hours", params: { highPriorityBypass: true } },
          ],
        },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-important`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("important"),
    },
    // 09:00 — deep inside protected sleep: low ping DEFERS, important reminder
    // BYPASSES and fires exactly once.
    {
      kind: "tick",
      name: "09:00 tick inside protected sleep → low ping defers, important reminder fires",
      worker: "lifeops_scheduler",
      options: { now: INSIDE_SLEEP_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: protectedSleepTick,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the important reminder only; the low-value ping stayed held",
      predicate: (): string | undefined => {
        // One delivery: the high-priority reminder that bypassed the gate. The
        // low-value ping deferred inside protected sleep and never delivered. A
        // second delivery would mean the low ping fired during sleep — the exact
        // regression this scenario guards.
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the important reminder; the low-value ping is held during protected sleep), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
