/**
 * F1 neurotypical-control-adversarial (pr-deterministic). CONTROL/CANARY: a
 * plain daily habit for a neutral owner fires on its LITERAL cadence across
 * three days with zero disruptions — the baseline that the D1/E1 persona
 * adaptations (adaptive wake windows, quiet-streak softening, shrink-the-ask
 * deferral) must NOT leak into. Drives the REAL scheduler tick (logical clock,
 * no LLM, no key) and asserts STRUCTURAL outcomes: exactly one fire per day at
 * the same 09:00 UTC occurrence, never shifted, never suppressed, never doubled.
 *
 * The realization here of "no accommodation leaked" is purely structural: three
 * consecutive daily cron occurrences each fire once, at their natural instant,
 * delivering exactly three times. A regression that re-anchored the neutral
 * owner's fires to an "observed wake" window (a night-owl B1 accommodation) or
 * softened a fire into a hold on a "quiet streak" (an E1 accommodation) would
 * miss, shift, or drop one of the three fires.
 *
 * Tasks are created through the REAL REST surface; ticks are the REAL scheduler
 * entry. Delivery goes through a scenario-registered always-delivering channel.
 * Absolute UTC instants keep the proof independent of host timezone; run keyless
 * with `TZ=UTC`.
 *
 * Fail-without-fix anchor: revert the recurrence refire in
 * `plugins/plugin-scheduling/src/scheduled-task/next-fire-at.ts` /
 * `runner.ts` (daily cron rows not re-armed at the next natural occurrence) and
 * the day-2 / day-3 ticks record no fire — the per-day fire turns and the
 * three-delivery finalCheck fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "f1-multiday-recurrence-control-baseline";
const DAILY_PROMPT = "Pack lunchboxes before the school run";
const DELIVERY_CHANNEL_KIND = "scenario_f1_control_recurrence_delivery";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The natural daily occurrence is 09:00 UTC. Anchor day 1 far enough ahead that
// only the injected tick `now` decides dueness, then tick 09:01 on each of the
// three days.
function nextUtcNineAfter(msAhead: number): Date {
  const earliest = new Date(Date.now() + msAhead);
  const nine = new Date(earliest);
  nine.setUTCHours(9, 0, 0, 0);
  if (nine.getTime() <= earliest.getTime()) {
    nine.setUTCDate(nine.getUTCDate() + 1);
  }
  return nine;
}

const DAY1_NINE = nextUtcNineAfter(2 * HOUR_MS);
const DAY1_TICK = new Date(DAY1_NINE.getTime() + MINUTE_MS); // day 1 09:01
const DAY2_TICK = new Date(DAY1_NINE.getTime() + DAY_MS + MINUTE_MS); // day 2 09:01
const DAY3_TICK = new Date(DAY1_NINE.getTime() + 2 * DAY_MS + MINUTE_MS); // day 3 09:01

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
  agentId: string;
  channelRegistry?: ChannelRegistryLike;
}

const deliveryLedger: unknown[] = [];
const captured: { dailyTaskId: string | null } = { dailyTaskId: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seedChannel(ctx: ScenarioContext): string | undefined {
  deliveryLedger.length = 0;
  captured.dailyTaskId = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario F1 control recurrence delivery probe" },
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

function dailyFires(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (!captured.dailyTaskId) {
    return "daily taskId was not captured from the create turn";
  }
  return fires.filter((fire) => fire.taskId === captured.dailyTaskId);
}

function assertCreated(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  captured.dailyTaskId = task.taskId;
  const trigger = isRecord(task.trigger) ? task.trigger : null;
  if (trigger?.kind !== "cron" || trigger.expression !== "0 9 * * *") {
    return `expected the plain daily cron trigger, saw ${JSON.stringify(task.trigger)}`;
  }
  return undefined;
}

// Each day: the neutral owner's fire lands once at its literal occurrence, at
// the expected running delivery total — never shifted or held.
function firedOnceOnDay(
  expectedDeliveryTotal: number,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = dailyFires(body);
    if (typeof fires === "string") return fires;
    if (fires.length !== 1) {
      return `expected exactly one control fire on this day, saw ${JSON.stringify(fires)}`;
    }
    const fire = fires[0];
    if (fire?.status !== "fired" || fire.reason !== "cron_due") {
      return `expected fired(cron_due) at the literal 09:00 occurrence (no re-anchor/hold), saw ${JSON.stringify(fire)}`;
    }
    if (deliveryLedger.length !== expectedDeliveryTotal) {
      return `expected ${expectedDeliveryTotal} deliveries by now, saw ${deliveryLedger.length}`;
    }
    return undefined;
  };
}

export default scenario({
  id: "f1-multiday-recurrence-control-baseline",
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
        cardinality: 3,
      },
    ],
  },
  title:
    "Control baseline: a plain daily habit fires once per day on its literal cadence, three days running",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "control",
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
      title: "F1 Control Recurrence Baseline",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "schedule the plain daily habit over REST",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: DAILY_PROMPT,
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-daily`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { dailyTaskId: "task.taskId" },
      assertResponse: assertCreated,
    },
    {
      kind: "tick",
      name: "day-1 tick → habit fires once at its literal 09:00 occurrence",
      worker: "lifeops_scheduler",
      options: { now: DAY1_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedOnceOnDay(1),
    },
    {
      kind: "tick",
      name: "day-2 tick → habit fires again, same literal cadence, not re-anchored",
      worker: "lifeops_scheduler",
      options: { now: DAY2_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedOnceOnDay(2),
    },
    {
      kind: "tick",
      name: "day-3 tick → habit fires a third time, no quiet-streak softening",
      worker: "lifeops_scheduler",
      options: { now: DAY3_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedOnceOnDay(3),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly three deliveries — one per day, none shifted or dropped",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 3) {
          return `expected exactly 3 deliveries (one per day, no accommodation leaked), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "state log records three fired transitions for the control habit",
      predicate: async (ctx: ScenarioContext): Promise<string | undefined> => {
        if (!captured.dailyTaskId) return "daily taskId was not captured";
        const { getScheduledTaskRunnerDeps } = await import(
          "@elizaos/plugin-scheduling"
        );
        const runtime = ctx.runtime as unknown as Parameters<
          typeof getScheduledTaskRunnerDeps
        >[0];
        const provider = getScheduledTaskRunnerDeps(runtime);
        if (!provider) {
          return "scheduled-task runner deps provider is not registered";
        }
        const agentId = (ctx.runtime as RuntimeLike).agentId;
        const deps = provider(runtime, agentId);
        const rows = await deps.logStore.list({
          agentId,
          taskId: captured.dailyTaskId,
        });
        const fired = rows.filter((row) => row.transition === "fired").length;
        if (fired !== 3) {
          return `expected exactly 3 fired transitions across the three days, saw ${fired}`;
        }
        return undefined;
      },
    },
  ],
});
