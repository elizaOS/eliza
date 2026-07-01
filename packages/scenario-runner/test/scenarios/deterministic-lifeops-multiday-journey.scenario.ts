/**
 * Deterministic multi-day scheduled-task journey with an injected clock.
 *
 * A daily 9:00 UTC reminder is created through the real SCHEDULED_TASKS
 * action (strict Stage-1 + planner fixtures), snoozed to Wednesday
 * afternoon, and then driven across three simulated days through the REAL
 * scheduler entry (`executeLifeOpsSchedulerTask` via the executor's `tick`
 * turn, `now` injected per tick):
 *
 *   Monday    — create the daily reminder, snooze it to Wednesday 15:00.
 *   Tuesday   — tick at 09:30: the natural 09:00 occurrence must NOT fire
 *               (the snooze override owns the next fire, and the
 *               override-time `next_fire_at` keeps the row out of the due
 *               slice); a follow-up `get` proves the task is still
 *               `scheduled`.
 *   Wednesday — tick at 15:05: the snooze override fires exactly once
 *               (`scheduled_override_due` at the promised 15:00 instant).
 *               The owner completes the occurrence.
 *   Thursday  — tick at 09:05: recurrence is real across occurrences — the
 *               COMPLETED daily task refires its next natural occurrence
 *               via the CAS refire claim (`cron_due`, reopened → fired).
 *
 * The final `history` turn asserts the full transition chain in the state
 * log: scheduled → snoozed → fire_attempt/fired (Wednesday) → completed →
 * fire_attempt/reopened/fired (Thursday).
 *
 * Fail-without-fix anchors (both landed on this branch):
 *   - revert the scheduled-override branch in
 *     `plugin-scheduling/src/scheduled-task/next-fire-at.ts` (snoozed rows
 *     index at the trigger's NEXT natural occurrence instead of the
 *     override) and the Wednesday tick records no fire — the turn fails;
 *   - revert the CAS recurrence-refire in `runner.ts fireWithResult` and
 *     the Thursday tick cannot reopen the completed occurrence — the
 *     Thursday turn fails.
 */

import { type IAgentRuntime, Service, ServiceType } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
} from "./_helpers/strict-llm-action-fixtures";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "deterministic-lifeops-multiday-journey";

// ---------------------------------------------------------------------------
// Simulated week — computed once at load, always in the future relative to
// the wall clock so only the injected tick `now` controls dueness.
// ---------------------------------------------------------------------------

function nextUtcMondayAt(hourUtc: number, minDaysAhead: number): Date {
  const base = new Date();
  base.setUTCHours(hourUtc, 0, 0, 0);
  let candidate = new Date(base);
  candidate.setUTCDate(candidate.getUTCDate() + minDaysAhead);
  for (let i = 0; i <= 7; i += 1) {
    if (candidate.getUTCDay() === 1) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  return candidate;
}

const DAY_MS = 24 * 60 * 60_000;
const MONDAY_9 = nextUtcMondayAt(9, 3);
const TUESDAY_TICK = new Date(MONDAY_9.getTime() + DAY_MS + 30 * 60_000); // Tue 09:30
const WEDNESDAY_OVERRIDE = new Date(
  MONDAY_9.getTime() + 2 * DAY_MS + 6 * 60 * 60_000,
); // Wed 15:00
const WEDNESDAY_TICK = new Date(WEDNESDAY_OVERRIDE.getTime() + 5 * 60_000); // Wed 15:05
const THURSDAY_OCCURRENCE = new Date(MONDAY_9.getTime() + 3 * DAY_MS); // Thu 09:00
const THURSDAY_TICK = new Date(THURSDAY_OCCURRENCE.getTime() + 5 * 60_000); // Thu 09:05

// ---------------------------------------------------------------------------
// Strict SCHEDULED_TASKS fixtures — one exact Stage-1 + planner pair per
// message turn (same template as deterministic-lifeops-scheduled-tasks).
// ---------------------------------------------------------------------------

const createText =
  "Run SCHEDULED_TASKS to create the daily pharmacy refill reminder";
const snoozeText =
  "Run SCHEDULED_TASKS to snooze the pharmacy reminder until Wednesday afternoon";
const getText =
  "Run SCHEDULED_TASKS to check the pharmacy reminder after the Tuesday tick";
const completeText = "Run SCHEDULED_TASKS to complete the pharmacy reminder";
const historyText = "Run SCHEDULED_TASKS to read the pharmacy reminder history";

const createParameters = {
  action: "create",
  kind: "reminder",
  promptInstructions: "call the pharmacy about the prescription refill",
  trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
  priority: "medium",
  idempotencyKey: `${SCENARIO_ID}-pharmacy`,
  respectsGlobalPause: false,
  ownerVisible: true,
  source: "user_chat",
  metadata: { scenario: SCENARIO_ID },
};

const snoozeParameters = {
  action: "snooze",
  taskId: "__created_task_id_unset__",
  untilIso: WEDNESDAY_OVERRIDE.toISOString(),
};

const getParameters = {
  action: "get",
  taskId: "__created_task_id_unset__",
};

const completeParameters = {
  action: "complete",
  taskId: "__created_task_id_unset__",
  reason: "owner confirmed the refill call happened",
};

const historyParameters = {
  action: "history",
  taskId: "__created_task_id_unset__",
  limit: 20,
};

let createdTaskId: string | null = null;
let scenarioRuntime: RuntimeWithScenarioLlmFixtures | null = null;

const initialStrictRoutes: StrictActionRouteFixture[] = [
  {
    actionName: "SCHEDULED_TASKS",
    args: createParameters,
    contextIds: ["tasks", "reminders"],
    input: createText,
    messageToUser: "Created daily pharmacy reminder.",
  },
];

function idDependentStrictRoutes(taskId: string): StrictActionRouteFixture[] {
  snoozeParameters.taskId = taskId;
  getParameters.taskId = taskId;
  completeParameters.taskId = taskId;
  historyParameters.taskId = taskId;
  return [
    {
      actionName: "SCHEDULED_TASKS",
      args: snoozeParameters,
      contextIds: ["tasks", "reminders"],
      input: snoozeText,
      messageToUser: "Snoozed pharmacy reminder to Wednesday.",
    },
    {
      actionName: "SCHEDULED_TASKS",
      args: getParameters,
      contextIds: ["tasks", "reminders"],
      input: getText,
      messageToUser: "Pharmacy reminder status read.",
    },
    {
      actionName: "SCHEDULED_TASKS",
      args: completeParameters,
      contextIds: ["tasks", "reminders"],
      input: completeText,
      messageToUser: "Completed pharmacy reminder.",
    },
    {
      actionName: "SCHEDULED_TASKS",
      args: historyParameters,
      contextIds: ["tasks", "reminders"],
      input: historyText,
      messageToUser: "pharmacy reminder log rows.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared-runtime hygiene: the CLI shares one runtime across scenarios, so a
// foreign live row could consume tick budget. Quiesce before, dismiss after.
// ---------------------------------------------------------------------------

interface ScheduledTaskLike {
  taskId: string;
  state: { status: string };
}

interface RunnerHandleLike {
  list(filter?: JsonRecord): Promise<ScheduledTaskLike[]>;
  apply(
    taskId: string,
    verb: string,
    payload?: JsonRecord,
  ): Promise<ScheduledTaskLike>;
}

interface RuntimeLike {
  agentId: string;
  getService?: (serviceType: string) => unknown;
  registerService?: (serviceDef: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
}

/**
 * Real NOTIFICATION delivery surface. The production in_app dispatcher only
 * reports `ok` when a live surface (assistant event bus or notification
 * service) accepts the payload — without one, every fire honestly defers as
 * `dispatch_deferred(disconnected)` instead of `fired`.
 */
class ScenarioNotificationSink extends Service {
  static override serviceType = ServiceType.NOTIFICATION;
  override capabilityDescription =
    "Scenario-owned NOTIFICATION service so in_app scheduled-task dispatch has a real delivery surface.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScenarioNotificationSink> {
    return new ScenarioNotificationSink(runtime);
  }

  override async stop(): Promise<void> {}

  async notify(_input: Record<string, unknown>): Promise<{ ok: true }> {
    return { ok: true };
  }
}

async function ensureNotificationSink(
  runtime: RuntimeLike,
): Promise<string | undefined> {
  if (runtime.getService?.(ServiceType.NOTIFICATION)) return undefined;
  if (typeof runtime.registerService !== "function") {
    return "runtime.registerService unavailable; cannot register the notification sink";
  }
  await runtime.registerService(ScenarioNotificationSink);
  // Registration is lazy — force the instance to start so the dispatcher's
  // synchronous getService(NOTIFICATION) sees a live surface on the ticks.
  await runtime.getServiceLoadPromise?.(ServiceType.NOTIFICATION);
  if (!runtime.getService?.(ServiceType.NOTIFICATION)) {
    return "notification sink did not start; in_app dispatch would honestly report disconnected";
  }
  return undefined;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

function resolveRunner(ctx: ScenarioContext): RunnerHandleLike | string {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  const service = runtime?.getService?.("lifeops_scheduled_task_runner") as {
    getRunner?: (opts: { agentId: string }) => RunnerHandleLike;
  } | null;
  if (!runtime || typeof service?.getRunner !== "function") {
    return "ScheduledTaskRunnerService is not registered on the scenario runtime";
  }
  return service.getRunner({ agentId: runtime.agentId });
}

async function seedJourney(ctx: ScenarioContext): Promise<string | undefined> {
  createdTaskId = null;
  snoozeParameters.taskId = "__created_task_id_unset__";
  getParameters.taskId = "__created_task_id_unset__";
  completeParameters.taskId = "__created_task_id_unset__";
  historyParameters.taskId = "__created_task_id_unset__";

  const sinkFailure = await ensureNotificationSink(ctx.runtime as RuntimeLike);
  if (sinkFailure) return sinkFailure;

  const runner = resolveRunner(ctx);
  if (typeof runner === "string") return runner;
  for (const task of await runner.list()) {
    if (!TERMINAL_STATUSES.has(task.state.status)) {
      await runner.apply(task.taskId, "dismiss", {
        reason: `${SCENARIO_ID}: quiescing shared-runtime store`,
      });
    }
  }

  scenarioRuntime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
  registerStrictActionRouteFixtures(scenarioRuntime, initialStrictRoutes);
  return undefined;
}

async function cleanupJourney(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!createdTaskId) return undefined;
  const runner = resolveRunner(ctx);
  if (typeof runner === "string") return undefined;
  await runner.apply(createdTaskId, "dismiss", {
    reason: `${SCENARIO_ID}: cleanup`,
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scheduledTasksAction(
  execution: ScenarioTurnExecution,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "SCHEDULED_TASKS",
  );
  return (
    action ??
    `expected SCHEDULED_TASKS action, saw ${
      execution.actionsCalled
        .map((candidate) => candidate.actionName)
        .join(", ") || "none"
    }`
  );
}

function actionTask(
  action: CapturedAction,
  expectedSubaction: string,
): JsonRecord | string {
  if (action.result?.success !== true) {
    return `expected ActionResult.success=true, saw ${JSON.stringify(action.result)}`;
  }
  const data = action.result?.data;
  if (!isRecord(data)) {
    return `expected ActionResult.data object, saw ${JSON.stringify(data)}`;
  }
  if (data.subaction !== expectedSubaction) {
    return `expected data.subaction=${expectedSubaction}, saw ${String(data.subaction)}`;
  }
  const task = data.task;
  return isRecord(task)
    ? task
    : `expected data.task object, saw ${JSON.stringify(task)}`;
}

function expectCreateTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = scheduledTasksAction(execution);
  if (typeof action === "string") return action;
  const task = actionTask(action, "create");
  if (typeof task === "string") return task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected created task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  const trigger = isRecord(task.trigger) ? task.trigger : null;
  if (trigger?.kind !== "cron" || trigger.expression !== "0 9 * * *") {
    return `expected daily cron trigger, saw ${JSON.stringify(task.trigger)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected created status=scheduled, saw ${JSON.stringify(task.state)}`;
  }
  createdTaskId = task.taskId;
  if (!scenarioRuntime) {
    return "scenario runtime unavailable for id-dependent strict fixtures";
  }
  registerStrictActionRouteFixtures(
    scenarioRuntime,
    idDependentStrictRoutes(createdTaskId),
  );
  return undefined;
}

function expectSnoozeTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = scheduledTasksAction(execution);
  if (typeof action === "string") return action;
  const task = actionTask(action, "snooze");
  if (typeof task === "string") return task;
  if (task.taskId !== createdTaskId) {
    return `expected snoozed task ${createdTaskId}, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected snoozed status=scheduled, saw ${JSON.stringify(task.state)}`;
  }
  if (state.firedAt !== WEDNESDAY_OVERRIDE.toISOString()) {
    return `expected snooze override at ${WEDNESDAY_OVERRIDE.toISOString()}, saw ${String(state.firedAt)}`;
  }
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
}

function readTickEntriesForTask(body: unknown): {
  fires: FireEntry[];
  completionTimeouts: FireEntry[];
} {
  const record = isRecord(body) ? body : {};
  const parse = (value: unknown): FireEntry[] =>
    (Array.isArray(value) ? value : [])
      .filter(isRecord)
      .filter((entry) => entry.taskId === createdTaskId)
      .map((entry) => ({
        taskId: String(entry.taskId),
        status: String(entry.status),
        reason: String(entry.reason),
        ...(typeof entry.occurrenceAtIso === "string"
          ? { occurrenceAtIso: entry.occurrenceAtIso }
          : {}),
      }));
  return {
    fires: parse(record.scheduledTaskFires),
    completionTimeouts: parse(record.scheduledTaskCompletionTimeouts),
  };
}

function assertTickBodySuccess(body: unknown): string | undefined {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const failures = Array.isArray(body.subsystemFailures)
    ? body.subsystemFailures.filter(isRecord)
    : [];
  const scheduledTasksFailure = failures.find(
    (failure) => failure.subsystem === "scheduled_tasks",
  );
  return scheduledTasksFailure
    ? `scheduled_tasks subsystem failed: ${JSON.stringify(scheduledTasksFailure)}`
    : undefined;
}

function assertTuesdayTick(_status: number, body: unknown): string | undefined {
  const bodyFailure = assertTickBodySuccess(body);
  if (bodyFailure) return bodyFailure;
  if (!createdTaskId) return "no created taskId before the Tuesday tick";
  const { fires, completionTimeouts } = readTickEntriesForTask(body);
  if (fires.length > 0) {
    return `snoozed reminder must NOT fire on Tuesday (natural 09:00 occurrence is overridden), saw ${JSON.stringify(fires)}`;
  }
  if (completionTimeouts.length > 0) {
    return `unexpected completion timeout on Tuesday: ${JSON.stringify(completionTimeouts)}`;
  }
  return undefined;
}

function expectStillScheduledTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = scheduledTasksAction(execution);
  if (typeof action === "string") return action;
  const task = actionTask(action, "get");
  if (typeof task === "string") return task;
  if (task.taskId !== createdTaskId) {
    return `expected task ${createdTaskId}, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected status=scheduled after the Tuesday tick, saw ${JSON.stringify(task.state)}`;
  }
  if (state.firedAt !== WEDNESDAY_OVERRIDE.toISOString()) {
    return `expected the snooze override to survive Tuesday, saw firedAt=${String(state.firedAt)}`;
  }
  return undefined;
}

function assertWednesdayTick(
  _status: number,
  body: unknown,
): string | undefined {
  const bodyFailure = assertTickBodySuccess(body);
  if (bodyFailure) return bodyFailure;
  const { fires } = readTickEntriesForTask(body);
  if (fires.length !== 1) {
    return `expected exactly one Wednesday fire for ${createdTaskId}, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "scheduled_override_due") {
    return `expected fired(scheduled_override_due), saw ${JSON.stringify(fire)}`;
  }
  if (fire.occurrenceAtIso !== WEDNESDAY_OVERRIDE.toISOString()) {
    return `expected the fire at the promised snooze instant ${WEDNESDAY_OVERRIDE.toISOString()}, saw ${String(fire.occurrenceAtIso)}`;
  }
  return undefined;
}

function expectCompleteTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = scheduledTasksAction(execution);
  if (typeof action === "string") return action;
  const task = actionTask(action, "complete");
  if (typeof task === "string") return task;
  if (task.taskId !== createdTaskId) {
    return `expected task ${createdTaskId}, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  return state?.status === "completed"
    ? undefined
    : `expected status=completed, saw ${JSON.stringify(task.state)}`;
}

function assertThursdayTick(
  _status: number,
  body: unknown,
): string | undefined {
  const bodyFailure = assertTickBodySuccess(body);
  if (bodyFailure) return bodyFailure;
  const { fires } = readTickEntriesForTask(body);
  if (fires.length !== 1) {
    return `expected the completed daily reminder to refire its Thursday occurrence (CAS recurrence refire), saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "cron_due") {
    return `expected fired(cron_due) on Thursday, saw ${JSON.stringify(fire)}`;
  }
  if (fire.occurrenceAtIso !== THURSDAY_OCCURRENCE.toISOString()) {
    return `expected the natural Thursday 09:00 occurrence ${THURSDAY_OCCURRENCE.toISOString()}, saw ${String(fire.occurrenceAtIso)}`;
  }
  return undefined;
}

function expectHistoryTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = scheduledTasksAction(execution);
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected ActionResult.success=true, saw ${JSON.stringify(action.result)}`;
  }
  const data = action.result?.data;
  if (!isRecord(data) || data.subaction !== "history") {
    return `expected history data, saw ${JSON.stringify(data)}`;
  }
  const transitions = (Array.isArray(data.entries) ? data.entries : [])
    .filter(isRecord)
    .map((entry) => entry.transition)
    .filter(
      (transition): transition is string => typeof transition === "string",
    );

  const counts = new Map<string, number>();
  for (const transition of transitions) {
    counts.set(transition, (counts.get(transition) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const required of ["scheduled", "snoozed", "completed", "reopened"]) {
    if ((counts.get(required) ?? 0) < 1) {
      problems.push(`missing '${required}' transition`);
    }
  }
  // Two real fires: the Wednesday snooze-override fire and the Thursday
  // recurrence refire — each preceded by a fire_attempt row.
  if ((counts.get("fired") ?? 0) < 2) {
    problems.push(`expected >=2 'fired' rows, saw ${counts.get("fired") ?? 0}`);
  }
  if ((counts.get("fire_attempt") ?? 0) < 2) {
    problems.push(
      `expected >=2 'fire_attempt' rows, saw ${counts.get("fire_attempt") ?? 0}`,
    );
  }
  return problems.length === 0
    ? undefined
    : `history transition chain incomplete: ${problems.join("; ")}; saw [${transitions.join(", ")}]`;
}

export default scenario({
  id: "deterministic-lifeops-multiday-journey",
  lane: "pr-deterministic",
  title:
    "Multi-day journey: snooze override, day-accurate ticks, and recurrence refire across occurrences",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "scheduled-tasks",
    "scheduler-tick",
    "long-horizon",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "quiesce shared store + register strict SCHEDULED_TASKS fixtures",
      apply: seedJourney,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "dismiss the journey reminder",
      apply: cleanupJourney,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic LifeOps Multi-Day Journey",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "Monday: create the daily pharmacy reminder",
      text: createText,
      responseIncludesAny: ["Created daily pharmacy reminder"],
      assertTurn: expectCreateTurn,
    },
    {
      kind: "message",
      name: "Monday: snooze it to Wednesday 15:00",
      text: snoozeText,
      responseIncludesAny: ["Snoozed pharmacy reminder"],
      assertTurn: expectSnoozeTurn,
    },
    {
      kind: "tick",
      name: "Tuesday 09:30 tick: the overridden occurrence does NOT fire",
      worker: "lifeops_scheduler",
      options: { now: TUESDAY_TICK.toISOString() },
      expectedStatus: 200,
      assertResponse: assertTuesdayTick,
    },
    {
      kind: "message",
      name: "Tuesday: task is still scheduled with the override intact",
      text: getText,
      responseIncludesAny: ["Pharmacy reminder status read"],
      assertTurn: expectStillScheduledTurn,
    },
    {
      kind: "tick",
      name: "Wednesday 15:05 tick: the snooze override fires once",
      worker: "lifeops_scheduler",
      options: { now: WEDNESDAY_TICK.toISOString() },
      expectedStatus: 200,
      assertResponse: assertWednesdayTick,
    },
    {
      kind: "message",
      name: "Wednesday: complete the fired occurrence",
      text: completeText,
      responseIncludesAny: ["Completed pharmacy reminder"],
      assertTurn: expectCompleteTurn,
    },
    {
      kind: "tick",
      name: "Thursday 09:05 tick: the completed daily task refires (CAS recurrence)",
      worker: "lifeops_scheduler",
      options: { now: THURSDAY_TICK.toISOString() },
      expectedStatus: 200,
      assertResponse: assertThursdayTick,
    },
    {
      kind: "message",
      name: "history shows the full multi-day transition chain",
      text: historyText,
      responseIncludesAny: ["pharmacy reminder log rows"],
      assertTurn: expectHistoryTurn,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SCHEDULED_TASKS",
      status: "success",
      minCount: 5,
    },
    {
      type: "selectedActionArguments",
      actionName: "SCHEDULED_TASKS",
      includesAll: [
        /"action":"create"/,
        /"action":"snooze"/,
        /"action":"get"/,
        /"action":"complete"/,
        /"action":"history"/,
        /call the pharmacy about the prescription refill/,
      ],
    },
  ],
});
