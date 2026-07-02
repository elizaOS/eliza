/**
 * Deterministic recurrence-across-occurrences coverage for the ScheduledTask
 * spine (#10723 recurrence-death, scenario-level).
 *
 * A daily 09:00 UTC reminder is scheduled through the REAL REST surface
 * (`POST /api/lifeops/scheduled-tasks`) and driven across two simulated days
 * through the REAL scheduler entry (`executeLifeOpsSchedulerTask` →
 * `processDueScheduledTasks`, via the executor's `tick` turn with an
 * injected `now`):
 *
 *   day 1 tick (09:01)  — the natural cron occurrence fires (`cron_due`);
 *   complete over REST  — the owner settles the day-1 occurrence
 *                         (`status: "completed"`), which must keep the
 *                         trigger-derived `next_fire_at` indexed at the
 *                         day-2 occurrence instead of clearing it;
 *   mid-day tick (15:00)— the completed daily row must NOT refire before its
 *                         next natural occurrence;
 *   day 2 tick (09:01)  — the COMPLETED recurring row resurfaces through the
 *                         CAS refire claim and fires AGAIN, clearing
 *                         `completedAt`.
 *
 * Runs keylessly: no message turns, no LLM calls. Delivery goes through a
 * scenario-registered always-delivering channel (the keyless runtime has no
 * in-app surface, and `in_app` dispatch honestly reports that as a typed
 * failure since 66e5d9d2c9) whose ledger must show exactly one delivery per
 * day. A custom final check reads the REAL DB-backed state log through the
 * runner's injected deps and requires exactly two `fired` transitions around
 * one `completed`.
 *
 * Fail-without-fix anchor: revert the recurrence fix in
 * `plugin-scheduling/src/scheduled-task/runner.ts` /
 * `next-fire-at.ts` (488814580d: terminal recurring rows kept out of the due
 * slice, `resolveNextFireAt` cleared on completion, no CAS refire) and the
 * day-2 tick records no fire for this task — the day-2 turn, the final
 * history turn, and the fired-count final check all fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "deterministic-lifeops-recurrence";
const DAILY_PROMPT = "Deterministic daily recurrence probe reminder";
const DELIVERY_CHANNEL_KIND = "scenario_recurrence_delivery";

// ---------------------------------------------------------------------------
// Simulated two days — always in the future relative to the wall clock so
// only the injected tick `now` controls dueness.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
const DAY1_TICK = new Date(DAY1_NINE.getTime() + MINUTE_MS); // day 1, 09:01
const MIDDAY_TICK = new Date(DAY1_NINE.getTime() + 6 * HOUR_MS); // day 1, 15:00
const DAY2_TICK = new Date(DAY1_NINE.getTime() + DAY_MS + MINUTE_MS); // day 2, 09:01

// ---------------------------------------------------------------------------
// Module state — reset by the seed so reruns inside a shared process stay
// deterministic.
// ---------------------------------------------------------------------------

let dailyTaskId: string | null = null;
let scenarioRuntime: RuntimeLike | null = null;
const deliveryLedger: unknown[] = [];

interface RunnerHandleLike {
  apply(taskId: string, verb: string, payload?: JsonRecord): Promise<unknown>;
}

interface RunnerServiceLike {
  getRunner(opts: { agentId: string }): RunnerHandleLike;
}

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
  getService?: (serviceType: string) => unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seedModuleState(ctx: ScenarioContext): string | undefined {
  dailyTaskId = null;
  deliveryLedger.length = 0;
  const runtime = ctx.runtime as RuntimeLike;
  scenarioRuntime = runtime;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  // The CLI shares one runtime across a run; registering twice throws, so
  // only the first execution installs the channel. The ledger above is
  // module state and reset every run either way.
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario recurrence delivery probe" },
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

async function dismissDailyTask(): Promise<string | undefined> {
  if (!scenarioRuntime || !dailyTaskId) return undefined;
  const service = scenarioRuntime.getService?.(
    "lifeops_scheduled_task_runner",
  ) as RunnerServiceLike | null | undefined;
  if (!service || typeof service.getRunner !== "function") return undefined;
  const runner = service.getRunner({ agentId: scenarioRuntime.agentId });
  await runner.apply(dailyTaskId, "dismiss", {
    reason: `${SCENARIO_ID}: cleanup`,
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Response readers
// ---------------------------------------------------------------------------

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
}

function readTickFires(body: unknown): FireEntry[] | string {
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
  const failures = Array.isArray(body.subsystemFailures)
    ? body.subsystemFailures.filter(isRecord)
    : [];
  const scheduledTasksFailure = failures.find(
    (failure) => failure.subsystem === "scheduled_tasks",
  );
  if (scheduledTasksFailure) {
    return `scheduled_tasks subsystem failed: ${JSON.stringify(scheduledTasksFailure)}`;
  }
  return fires;
}

function dailyFires(body: unknown): FireEntry[] | string {
  const fires = readTickFires(body);
  if (typeof fires === "string") return fires;
  if (!dailyTaskId) return "daily taskId was not captured from the create turn";
  return fires.filter((fire) => fire.taskId === dailyTaskId);
}

function assertCreated(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  dailyTaskId = task.taskId;
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected created task.state.status=scheduled, saw ${JSON.stringify(state?.status)}`;
  }
  const trigger = isRecord(task.trigger) ? task.trigger : null;
  if (trigger?.kind !== "cron" || trigger.expression !== "0 9 * * *") {
    return `expected the daily cron trigger, saw ${JSON.stringify(task.trigger)}`;
  }
  const output = isRecord(task.output) ? task.output : null;
  if (
    output?.destination !== "channel" ||
    output.target !== `${DELIVERY_CHANNEL_KIND}:owner`
  ) {
    return `expected output routed at the delivery channel, saw ${JSON.stringify(task.output)}`;
  }
  return undefined;
}

function assertDayOneTick(_status: number, body: unknown): string | undefined {
  const fires = dailyFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one day-1 fire for the daily task, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "cron_due") {
    return `expected day-1 fired(cron_due), saw ${JSON.stringify(fire)}`;
  }
  if (deliveryLedger.length !== 1) {
    return `expected exactly one delivery by day-1, saw ${deliveryLedger.length}`;
  }
  return undefined;
}

function assertDayOneHistory(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body)) return `expected history object, saw ${typeof body}`;
  if (body.status !== "fired") {
    return `expected day-1 status=fired, saw ${JSON.stringify(body.status)}`;
  }
  if (body.firedAt !== DAY1_TICK.toISOString()) {
    return `expected day-1 firedAt=${DAY1_TICK.toISOString()}, saw ${JSON.stringify(body.firedAt)}`;
  }
  return undefined;
}

function assertCompleted(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const state = isRecord(body.task.state) ? body.task.state : null;
  if (state?.status !== "completed") {
    return `expected status=completed after the REST complete verb, saw ${JSON.stringify(state?.status)}`;
  }
  return undefined;
}

function assertMiddayTick(_status: number, body: unknown): string | undefined {
  const fires = dailyFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 0) {
    return `the completed daily task must not refire before its next occurrence, saw ${JSON.stringify(fires)}`;
  }
  if (deliveryLedger.length !== 1) {
    return `expected no mid-day delivery, saw ${deliveryLedger.length} total`;
  }
  return undefined;
}

function assertDayTwoTick(_status: number, body: unknown): string | undefined {
  const fires = dailyFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one day-2 refire for the completed daily task, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "cron_due") {
    return `expected day-2 fired(cron_due) via the CAS refire, saw ${JSON.stringify(fire)}`;
  }
  if (deliveryLedger.length !== 2) {
    return `expected the day-2 refire to deliver again, saw ${deliveryLedger.length} total deliveries`;
  }
  return undefined;
}

function assertDayTwoHistory(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body)) return `expected history object, saw ${typeof body}`;
  if (body.status !== "fired") {
    return `expected day-2 status=fired, saw ${JSON.stringify(body.status)}`;
  }
  if (body.firedAt !== DAY2_TICK.toISOString()) {
    return `expected day-2 firedAt=${DAY2_TICK.toISOString()}, saw ${JSON.stringify(body.firedAt)}`;
  }
  if (body.completedAt !== undefined && body.completedAt !== null) {
    return `expected the refire to clear completedAt, saw ${JSON.stringify(body.completedAt)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Final check — the DB-backed state log proves fired → completed → fired.
// ---------------------------------------------------------------------------

async function assertStateLog(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!dailyTaskId) return "daily taskId was not captured";
  const { getScheduledTaskRunnerDeps } = await import(
    "@elizaos/plugin-scheduling"
  );
  const runtime = ctx.runtime as unknown as Parameters<
    typeof getScheduledTaskRunnerDeps
  >[0];
  const provider = getScheduledTaskRunnerDeps(runtime);
  if (!provider) return "scheduled-task runner deps provider is not registered";
  const agentId = (ctx.runtime as RuntimeLike).agentId;
  const deps = provider(runtime, agentId);
  const rows = await deps.logStore.list({ agentId, taskId: dailyTaskId });
  const transitions = rows.map((row) => row.transition);
  // The log sorts by occurredAtIso, and this scenario mixes clocks (the REST
  // `complete` stamps real wall-clock time while the ticks stamp injected
  // future time), so assert the transition multiset, not wall-clock order.
  const count = (transition: string): number =>
    transitions.filter((candidate) => candidate === transition).length;
  if (count("fired") !== 2) {
    return `expected exactly 2 fired transitions across the two days, saw ${count("fired")} in [${transitions.join(", ")}]`;
  }
  if (count("completed") !== 1) {
    return `expected exactly one completed transition, saw ${count("completed")} in [${transitions.join(", ")}]`;
  }
  // The CAS refire path is the load-bearing bit of #10723: the terminal
  // (completed) recurring row must be REOPENED before its day-2 fire.
  if (count("reopened") < 1) {
    return `expected a reopened transition from the CAS refire, saw [${transitions.join(", ")}]`;
  }
  return undefined;
}

function assertDeliveryLedger(): string | undefined {
  if (deliveryLedger.length !== 2) {
    return `expected exactly 2 deliveries (one per day), saw ${deliveryLedger.length}`;
  }
  for (const [index, payload] of deliveryLedger.entries()) {
    const record = isRecord(payload) ? payload : null;
    const metadata = isRecord(record?.metadata) ? record.metadata : null;
    if (metadata?.taskId !== dailyTaskId) {
      return `delivery ${index} was not for the daily task: ${JSON.stringify(payload)}`;
    }
    if (record?.message !== DAILY_PROMPT) {
      return `delivery ${index} carried the wrong message: ${JSON.stringify(record?.message)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-lifeops-recurrence",
  lane: "pr-deterministic",
  title:
    "Daily cron reminder fired and completed on day 1 refires on day 2 through the real scheduler tick",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "scheduled-tasks",
    "recurrence",
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
      name: "register the always-delivering probe channel",
      apply: seedModuleState,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "dismiss the daily task",
      apply: dismissDailyTask,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "schedule the daily reminder over REST",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: DAILY_PROMPT,
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        priority: "low",
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
      name: "day-1 tick fires the natural occurrence",
      worker: "lifeops_scheduler",
      options: { now: DAY1_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDayOneTick,
    },
    {
      kind: "api",
      name: "day-1 fire stamped the injected tick clock",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks/{{capture:dailyTaskId}}/history",
      expectedStatus: 200,
      assertResponse: assertDayOneHistory,
    },
    {
      kind: "api",
      name: "owner completes the day-1 occurrence over REST",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:dailyTaskId}}/complete",
      body: { reason: `${SCENARIO_ID}: day-1 done` },
      expectedStatus: 200,
      assertResponse: assertCompleted,
    },
    {
      kind: "tick",
      name: "mid-day tick must not refire the completed task",
      worker: "lifeops_scheduler",
      options: { now: MIDDAY_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertMiddayTick,
    },
    {
      kind: "tick",
      name: "day-2 tick refires the completed recurring task",
      worker: "lifeops_scheduler",
      options: { now: DAY2_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDayTwoTick,
    },
    {
      kind: "api",
      name: "day-2 refire reopened the row and stamped day-2 time",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks/{{capture:dailyTaskId}}/history",
      expectedStatus: 200,
      assertResponse: assertDayTwoHistory,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "state log proves fired → completed → fired across two days",
      predicate: assertStateLog,
    },
    {
      type: "custom",
      name: "delivery ledger carries exactly one message per day for this task",
      predicate: assertDeliveryLedger,
    },
  ],
});
