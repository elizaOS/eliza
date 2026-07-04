/**
 * E1 low-activation-reengagement (pr-deterministic). Deterministic ScheduledTask
 * proof for "one small step, deferred — never dropped": when a low-activation
 * owner can't face the tiny step right now, the assistant PARKS it (snooze) to a
 * gentler later time rather than letting it fall on the floor, and it resurfaces
 * on its own exactly once at the promised instant — it neither nags early nor
 * gets lost. Drives the REAL scheduler tick (logical clock, no LLM, no key) and
 * asserts STRUCTURAL outcomes (the parked occurrence is suppressed until its
 * promise, then fires exactly once), not routing. Maps to LifeOpsBench
 * lowact.postpone_without_shame; the live conversational judge of the
 * shame-free deferral tone stays on the bench LIVE surface.
 *
 * The task is created and parked through the REAL REST surface; the tick is the
 * REAL scheduler entry. Delivery goes through a scenario-registered
 * always-delivering channel. Absolute instants + an explicit snooze `untilIso`
 * keep the proof independent of host timezone. Run keyless with `TZ=UTC`.
 *
 * NO crisis guard is asserted (ordinary snooze/resurface; #12780 not-planned).
 *
 * Fail-without-fix anchor:
 *   - Revert the scheduled-override branch in
 *     `plugins/plugin-scheduling/src/scheduled-task/next-fire-at.ts` (snoozed
 *     rows index at the trigger's NEXT natural occurrence instead of the
 *     override instant) and either the parked step fires during the early tick
 *     (the "does not resurface early" turn fails) or never resurfaces at the
 *     promised instant (the "resurfaces once" turn + single-delivery finalCheck
 *     fail).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "lowact-micro-step-deferred-not-dropped";
const DELIVERY_CHANNEL_KIND = "scenario_micro_step_delivery";

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

// The micro-step would naturally fire at 09:00; the owner can't face it, so it
// is parked to 16:00. Ticks straddle both.
const CAPTURE_INSTANT = futureDateAtUtc(9, 0, 2);
const PARK_UNTIL = futureDateAtUtc(16, 0, 2);
const EARLY_TICK = futureDateAtUtc(9, 5, 2); // 09:05 — parked, must stay quiet
const RESURFACE_TICK = futureDateAtUtc(16, 5, 2); // 16:05 — the gentle later time

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
const capturedTaskIds: { parked: string | null } = { parked: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedChannel(ctx: ScenarioContext): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.parked = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario micro-step deferral delivery probe" },
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

function firesForParked(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (typeof capturedTaskIds.parked !== "string") {
    return "captured taskId was not set by the create turn";
  }
  return fires.filter((fire) => fire.taskId === capturedTaskIds.parked);
}

function captureParkedTaskId(
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
  capturedTaskIds.parked = task.taskId;
  return undefined;
}

function assertParked(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response from snooze, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (task.taskId !== capturedTaskIds.parked) {
    return `expected snoozed task ${capturedTaskIds.parked}, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected parked task to remain scheduled, saw ${JSON.stringify(task.state)}`;
  }
  return undefined;
}

function assertNoEarlyFire(_status: number, body: unknown): string | undefined {
  const fires = firesForParked(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `parked micro-step must NOT fire before its promised time, saw ${JSON.stringify(fired)}`;
  }
  return undefined;
}

function assertResurfacesOnce(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = firesForParked(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one resurface fire for the parked micro-step, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "scheduled_override_due") {
    return `expected fired(scheduled_override_due) at the promised instant, saw ${JSON.stringify(fire)}`;
  }
  return undefined;
}

export default scenario({
  id: "lowact-micro-step-deferred-not-dropped",
  lane: "pr-deterministic",
  title:
    "Low activation: a parked one-small-step resurfaces once at its gentle later time, never dropped or early",
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
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Low activation micro-step",
    },
  ],
  turns: [
    // Capture the one small step with a natural fire instant.
    {
      kind: "api",
      name: "capture the one small step",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "one small step — open the laundry basket lid",
        trigger: { kind: "once", atIso: CAPTURE_INSTANT.toISOString() },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-micro-step`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { parkedTaskId: "task.taskId" },
      assertResponse: captureParkedTaskId,
    },
    // The owner can't face it now — park it to a gentler later time.
    {
      kind: "api",
      name: "park the step (snooze) to a gentler later time",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:parkedTaskId}}/snooze",
      body: { untilIso: PARK_UNTIL.toISOString() },
      expectedStatus: 200,
      assertResponse: assertParked,
    },
    // Early tick: the parked step is suppressed — it does NOT nag before its time.
    {
      kind: "tick",
      name: "tick at the original time → parked step does NOT resurface early",
      worker: "lifeops_scheduler",
      options: { now: EARLY_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertNoEarlyFire,
    },
    // The promised time: the parked step resurfaces exactly once.
    {
      kind: "tick",
      name: "tick at the promised later time → parked step resurfaces exactly once",
      worker: "lifeops_scheduler",
      options: { now: RESURFACE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertResurfacesOnce,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the resurfaced step, never early",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the resurfaced micro-step), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
