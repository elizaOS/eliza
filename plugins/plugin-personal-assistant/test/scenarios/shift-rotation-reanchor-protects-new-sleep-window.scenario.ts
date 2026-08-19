/**
 * B2 shift-rotation (pr-deterministic). Deterministic ScheduledTask proof of the
 * core rotating-shift (P3 marcus_shift) mechanic: after the owner rotates onto a
 * night shift, a recurring habit reminder is RE-ANCHORED to the shifted waking
 * window and NEVER fires inside the newly-protected daytime sleep block. Drives
 * the REAL scheduler tick (logical clock, no LLM, no key) and asserts STRUCTURAL
 * outcomes (which occurrence of the SAME task fires at which clock instant under
 * the rotated owner facts), not routing. Maps to LifeOpsBench
 * shiftrotation.reanchor_recurring_reminders_to_new_shift; the live conversational
 * capture of the same intent stays on the bench + live-only scenario-runner
 * surface.
 *
 * A single `during_window: morning` habit carries the proof. Its firing window is
 * read LIVE from owner facts at every tick (`due.ts` / `windowBoundsMinutes`
 * reads `ownerFacts.morningWindow` per evaluation), so seeding the night-rotation
 * facts (waking "morning" 15:00–18:00; protected daytime sleep as quiet-hours
 * 06:00–15:00) re-anchors the habit without touching the task literal. At the
 * PRE-rotation waking instant (08:00 — the slot this habit used to fire on under
 * a day shift) the habit is now SILENT because 08:00 falls inside the protected
 * sleep block; at the shifted waking window (15:30) it FIRES. A companion
 * quiet_hours-gated reminder DEFERS at 08:00 with a derived gate reason, proving
 * the daytime sleep block is protected. Non-echo: the asserted tokens are fire
 * STATUS and the derived `quiet_hours: deferring …` reason, never text from a
 * turn.
 *
 * The single-run design mirrors persona.flexible-scheduling: owner facts are
 * seeded once through the REAL OwnerFactStore (the scenario runner has no
 * mid-run owner-fact mutation lever), tasks are created through the REAL REST
 * surface, and delivery goes through a scenario-registered always-delivering
 * channel. The "day shift → night shift" transition is realized by seeding the
 * post-rotation facts and asserting the SAME habit no longer fires on the old
 * waking slot; the pre-rotation baseline (a day-shift 08:00 fire) is proved by
 * persona.flexible-scheduling's during_window fire against a 07:00–10:00 morning.
 * Run keyless with `TZ=UTC` so window math is unambiguous.
 *
 * Fail-without-fix anchors:
 *   - Make `during_window` dueness read a persisted/cached window instead of live
 *     owner facts in `plugins/plugin-scheduling/src/scheduled-task/due.ts`
 *     (`windowBoundsMinutes`) and the habit fires at the 08:00 tick inside the
 *     protected sleep block — the "does NOT fire" turn fails and the delivery
 *     ledger grows past one.
 *   - Revert the `quiet_hours` gate's live read of `ownerFacts.quietHours` in
 *     `plugins/plugin-scheduling/src/scheduled-task/gate-registry.ts` and the
 *     protected-sleep companion reminder fires during the daytime sleep block —
 *     the "defers with quiet_hours reason" turn fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "shift-rotation-reanchor-protects-new-sleep-window";
const DELIVERY_CHANNEL_KIND = "scenario_shift_reanchor_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now` decides
// dueness. UTC throughout so window math is unambiguous. Post-rotation (night)
// owner facts: waking "morning" 15:00–18:00; protected daytime sleep as
// quiet-hours 06:00–15:00. 08:00 is the pre-rotation waking slot, now inside
// protected sleep; 15:30 is inside the shifted waking window.
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

// 08:00 — the pre-rotation waking slot, now inside the protected daytime sleep.
const OLD_MORNING_TICK = futureDateAtUtc(8, 0, 2);
// 15:30 — inside the shifted (post-rotation) waking window.
const NEW_MORNING_TICK = futureDateAtUtc(15, 30, 2);

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
const capturedTaskIds: { habit: string | null; sleepGuard: string | null } = {
  habit: null,
  sleepGuard: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedNightRotationFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.habit = null;
  capturedTaskIds.sleepGuard = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario shift re-anchor delivery probe" },
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
  // Post-rotation (night) owner facts. Waking "morning" is the afternoon; the
  // protected sleep block covers the pre-rotation waking slot (08:00).
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "15:00", endLocal: "18:00" },
      eveningWindow: { startLocal: "23:00", endLocal: "05:00" },
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

function notFiredFor(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    const fired = fires.filter((f) => f.status === "fired");
    if (fired.length !== 0) {
      return `expected ${slot} NOT to fire inside protected sleep, saw ${JSON.stringify(fired)}`;
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

export default scenario({
  id: "shift-rotation-reanchor-protects-new-sleep-window",
  lane: "pr-deterministic",
  title:
    "Shift rotation re-anchors a habit reminder to the shifted waking window and never fires it inside the newly-protected sleep block",
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
      name: "seed post-rotation (night) owner facts and delivery channel",
      apply: seedNightRotationFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Shift Rotation Re-anchor",
    },
  ],
  turns: [
    // The recurring habit: a during_window: morning reminder. Its firing window
    // is read live from owner facts, so under the rotated facts it fires in the
    // afternoon waking window, not the pre-rotation morning.
    {
      kind: "api",
      name: "create the during_window morning habit reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning shift-routine habit reminder",
        trigger: { kind: "during_window", windowKey: "morning" },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-morning-habit`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("habit"),
    },
    // A companion reminder gated by quiet_hours. The gate reads
    // ownerFacts.quietHours live, so under the rotated daytime sleep block it is
    // HELD at the 08:00 tick.
    {
      kind: "api",
      name: "create the quiet-hours-gated protected-sleep companion reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "recurring ping that must respect protected sleep",
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
        idempotencyKey: `${SCENARIO_ID}-sleep-guard`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("sleepGuard"),
    },
    // 08:00 — the pre-rotation waking slot, now inside the protected daytime
    // sleep block: the re-anchored habit must NOT fire, and the sleep-guard
    // reminder must DEFER with a quiet_hours reason. This is the re-anchor: the
    // routine follows the shift and protects the new sleep window.
    {
      kind: "tick",
      name: "08:00 tick (pre-rotation slot, now protected sleep) → habit silent; sleep-guard defers",
      worker: "lifeops_scheduler",
      options: {
        now: OLD_MORNING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: (_status, body): string | undefined =>
        notFiredFor("habit")(_status, body) ??
        deferredFor("sleepGuard", "quiet_hours")(_status, body),
    },
    // 15:30 — inside the shifted waking window: the habit fires at its new
    // anchor.
    {
      kind: "tick",
      name: "15:30 tick (shifted waking window) → morning habit fires at its re-anchored window",
      worker: "lifeops_scheduler",
      options: {
        now: NEW_MORNING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: firedFor("habit"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly two deliveries — both at/after the shifted waking window, none inside protected sleep",
      predicate: (): string | undefined => {
        // Two deliveries land at the 15:30 tick: the re-anchored habit
        // (`window_due`) plus the sleep-guard reminder RELEASED from its earlier
        // defer (`scheduled_override_due`, re-armed to the quiet-hours end at
        // 15:00) — the deferred ping is correctly held through protected sleep
        // and delivered only once sleep is over. The load-bearing invariant is
        // proved by the 08:00 turn: nothing fires inside the protected block. A
        // THIRD delivery would mean the habit ALSO fired at the 08:00 tick,
        // inside protected sleep — the exact re-anchor regression this scenario
        // guards.
        if (deliveryLedger.length !== 2) {
          return `expected exactly 2 deliveries (the re-anchored habit + the released sleep-guard, both after protected sleep ends), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
