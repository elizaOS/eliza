/**
 * A1 adhd-capture-and-start (pr-deterministic). Deterministic ScheduledTask
 * proof for the ADHD "distractor storm" park-then-resurface: a captured task is
 * PARKED (snoozed) when the storm hits rather than chased now, and then RESURFACES
 * on its own at the promised later time — it neither gets lost nor fires early.
 * Drives the REAL scheduler tick (logical clock, no LLM, no key) and asserts
 * STRUCTURAL outcomes (the parked occurrence is suppressed at storm time and the
 * override fires exactly once later), not routing. Maps to LifeOpsBench
 * live.adhd.distractor_storm_park_then_capture; the live conversational judge of
 * "park, don't chase" stays on the bench LIVE surface.
 *
 * The realization of the bench "delta:1" capture in the deterministic surface is
 * "exactly one real fire+delivery of the parked task, at the resurface instant" —
 * the scheduler-side analog the keyless proxy can prove (LifeOps definitions are
 * only created through a live model call).
 *
 * Tasks are created and parked through the REAL REST surface; the tick is the
 * REAL scheduler entry. Delivery goes through a scenario-registered
 * always-delivering channel. Absolute instants + an explicit snooze `untilIso`
 * keep the proof independent of host timezone.
 *
 * Fail-without-fix anchor:
 *   - Revert the scheduled-override branch in
 *     `plugins/plugin-scheduling/src/scheduled-task/next-fire-at.ts` (snoozed rows
 *     index at the trigger's NEXT natural occurrence instead of the override
 *     instant) and either the parked task fires during the storm tick (the
 *     "does not resurface early" turn fails) or never resurfaces at the promised
 *     instant (the "resurfaces once" turn + single-delivery finalCheck fail).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-distractor-storm-mid-capture";
const DELIVERY_CHANNEL_KIND = "scenario_distractor_storm_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future. The captured task would naturally
// fire at 10:00; the storm hits, we park it until 13:00. Ticks straddle both.
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

const CAPTURE_INSTANT = futureDateAtUtc(10, 0, 2); // natural fire at 10:00
const PARK_UNTIL = futureDateAtUtc(13, 0, 2); // resurface at 13:00
const STORM_TICK = futureDateAtUtc(10, 5, 2); // 10:05 — during the storm
const RESURFACE_TICK = futureDateAtUtc(13, 5, 2); // 13:05 — storm cleared

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
      describe: { label: "Scenario distractor-storm delivery probe" },
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

// ---------------------------------------------------------------------------
// Response readers.
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

function assertNoStormFire(_status: number, body: unknown): string | undefined {
  const fires = firesForParked(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `parked task must NOT resurface during the storm (natural occurrence is overridden), saw ${JSON.stringify(fired)}`;
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
    return `expected exactly one resurface fire for the parked task, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "scheduled_override_due") {
    return `expected fired(scheduled_override_due) at the resurface instant, saw ${JSON.stringify(fire)}`;
  }
  return undefined;
}

export default scenario({
  id: "adhd-distractor-storm-mid-capture",
  lane: "pr-deterministic",
  title:
    "ADHD distractor storm: a parked capture resurfaces once at its promised time, never early",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "adhd",
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
      name: "register the delivery channel and reset the ledger",
      apply: seedChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Distractor Storm",
    },
  ],
  turns: [
    // Capture the load-bearing task with a natural fire instant.
    {
      kind: "api",
      name: "capture the load-bearing task",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "reply to Morgan about the signed contract",
        trigger: { kind: "once", atIso: CAPTURE_INSTANT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-parked-capture`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      // Capture the runtime taskId two ways: into a scenario variable so the
      // snooze turn can template it into the REST path, and into module state so
      // the tick readers can filter fires by it.
      captures: { parkedTaskId: "task.taskId" },
      assertResponse: captureParkedTaskId,
    },
    // The storm hits — park the capture until later instead of chasing it now.
    {
      kind: "api",
      name: "park the capture (snooze) until the storm clears",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:parkedTaskId}}/snooze",
      body: { untilIso: PARK_UNTIL.toISOString() },
      expectedStatus: 200,
      assertResponse: assertParked,
    },
    // During the storm: the parked occurrence is suppressed — it does NOT fire.
    {
      kind: "tick",
      name: "tick during the storm → parked capture does NOT resurface early",
      worker: "lifeops_scheduler",
      options: { now: STORM_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertNoStormFire,
    },
    // Storm cleared: the parked capture resurfaces exactly once at its promise.
    {
      kind: "tick",
      name: "tick after the storm → parked capture resurfaces exactly once",
      worker: "lifeops_scheduler",
      options: { now: RESURFACE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertResurfacesOnce,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the resurfaced capture, never during the storm",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the resurfaced capture), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
