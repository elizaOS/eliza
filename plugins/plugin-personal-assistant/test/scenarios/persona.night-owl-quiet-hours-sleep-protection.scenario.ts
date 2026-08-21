/**
 * B1 night-owl-anchored-day (pr-deterministic). Deterministic ScheduledTask
 * proof for noor_night's sleep-protection window: her quiet hours run 04:00–11:30
 * (a delayed sleep phase, not the neurotypical 22:00–06:00), and a low-value
 * reminder that lands inside that window is HELD, while a high-priority reminder
 * breaks through. Drives the REAL scheduler tick (logical clock, no LLM, no key)
 * and asserts STRUCTURAL outcomes (which task defers vs. fires, and what actually
 * gets delivered), not routing.
 *
 * Owner facts (timezone + her 04:00–11:30 quiet hours) are seeded through the
 * REAL OwnerFactStore. Tasks are created through the REAL REST surface. Delivery
 * goes through a scenario-registered always-delivering channel so fires have a
 * real surface. Run keyless with `TZ=UTC` so quiet-hours window math is
 * unambiguous.
 *
 * Maps to LifeOpsBench nightowl.anchored.sleep_protection_quiet_window /
 * multi_day_quiet_hours_consistency; the live conversational judge of "protect
 * her sleep, don't schedule fake morning stuff in there" stays on the bench LIVE
 * surface. The realization of the bench capture in the deterministic surface is
 * "the low-value reminder is held while she sleeps, and only the high-priority
 * one is delivered" — the scheduler-side analog the keyless proxy can prove,
 * since LifeOps definitions are only created through a live model call.
 *
 * Fail-without-fix anchors:
 *   - Revert the `quiet_hours` gate's window read so it ignores the seeded
 *     04:00–11:30 owner window (or reverts to a default 22:00–06:00) and the
 *     low-value reminder fires at 08:00 while she sleeps — the "defers, not
 *     fires" turn fails and the delivery ledger grows past one.
 *   - Break `highPriorityBypass` so the high-priority reminder is also held
 *     during quiet hours — the "high priority breaks through" turn fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "persona.night-owl-quiet-hours-sleep-protection";
const DELIVERY_CHANNEL_KIND = "scenario_night_owl_quiet_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now` decides
// dueness. Timezone UTC. Noor's quiet hours are 04:00–11:30 — 08:00 is squarely
// inside them (she is asleep), so a quiet-hours-gated reminder must be held.
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

const INSIDE_HER_SLEEP_TICK = futureDateAtUtc(8, 0, 2); // 08:00 — she is asleep

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
  lowValue: string | null;
  highPriority: string | null;
} = { lowValue: null, highPriority: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.lowValue = null;
  capturedTaskIds.highPriority = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario night-owl quiet-hours delivery probe" },
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

  // Seed owner facts through the REAL store: her DELAYED-PHASE quiet hours,
  // 04:00–11:30 — the whole point of the pack. The quiet_hours gate reads this.
  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  await store.update(
    {
      timezone: "UTC",
      quietHours: { startLocal: "04:00", endLocal: "11:30", timezone: "UTC" },
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

// One tick inside her sleep window: the low-value reminder is HELD by quiet
// hours; the high-priority reminder bypasses and fires.
function protectsSleep(_status: number, body: unknown): string | undefined {
  return (
    deferredFor("lowValue", "quiet_hours")(_status, body) ??
    firedFor("highPriority")(_status, body)
  );
}

export default scenario({
  // Literal (not SCENARIO_ID) so the corpus guard + coverage gate, which read
  // the id statically, resolve it.
  id: "persona.night-owl-quiet-hours-sleep-protection",
  lane: "pr-deterministic",
  title:
    "Night owl sleep protection: a low-value reminder is held in her 04:00–11:30 quiet hours; only a high-priority one breaks through",
  domain: "lifeops",
  evidenceScope: "domain-contract",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "night-owl",
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
      name: "seed owner facts (04:00–11:30 quiet hours) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Night Owl Sleep Protection",
    },
  ],
  turns: [
    // A low-value reminder gated by quiet_hours: it must be HELD while she sleeps.
    {
      kind: "api",
      name: "create the low-value reminder (quiet-hours gated)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "optional: tidy the desktop when convenient",
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
        idempotencyKey: `${SCENARIO_ID}-low-value`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("lowValue"),
    },
    // A high-priority reminder gated by the SAME quiet_hours gate: it must break
    // through via highPriorityBypass even while she sleeps.
    {
      kind: "api",
      name: "create the high-priority reminder (same gate, bypasses)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "urgent: the on-call page needs an ack",
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
        idempotencyKey: `${SCENARIO_ID}-high-priority`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("highPriority"),
    },
    // A single tick at 08:00, deep inside her 04:00–11:30 sleep window: the
    // low-value reminder defers on quiet_hours; the high-priority one fires.
    {
      kind: "tick",
      name: "tick at 08:00 (inside her sleep window) → low held, high fires",
      worker: "lifeops_scheduler",
      options: {
        now: INSIDE_HER_SLEEP_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: protectsSleep,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the high-priority reminder, never the low-value one",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the high-priority reminder; the low-value one is held in her sleep window), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
