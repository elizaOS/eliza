/**
 * Deterministic concurrent-day scheduler-tick coverage.
 *
 * Seeds 26 scheduled tasks that are ALL due inside one tick window — three
 * high-priority tasks (an approval, a check-in, a medication reminder), a
 * gate-blocked reminder, 21 medium fillers, and one low-priority task created
 * last — then drives the REAL scheduler entry
 * (`executeLifeOpsSchedulerTask` → `processDueScheduledTasks`, via the
 * executor's `tick` turn) twice and asserts the exact fire ledger:
 *
 *   - the per-tick task budget (DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT = 25)
 *     is respected: tick 1 records exactly 25 ledger entries;
 *   - tasks are visited in deterministic creation order (`created_at ASC`),
 *     which is why the high-priority tasks are seeded first and must appear
 *     first in the ledger — priority ordering is encoded at creation time,
 *     not re-sorted by the tick;
 *   - each visited task is recorded with its real post-fire state: fired
 *     tasks show `status: "fired", reason: "once_due"`, the gate-blocked
 *     task shows `status: "skipped"` with the `weekday_only` denial reason;
 *   - nothing is lost: the low-priority task past the limit is absent from
 *     tick 1, still `scheduled` in the store, and fires on tick 2 — the
 *     two ledgers together account for every seeded task exactly once.
 *
 * Runs keylessly: no message turns, no LLM calls — the strict proxy is never
 * consulted. The seed schedules through the production
 * `ScheduledTaskRunnerService` (PA's DB-backed deps), the same path the
 * SCHEDULED_TASKS action uses, and registers a real NOTIFICATION service so
 * in_app dispatch has a live delivery surface (the dispatcher honestly
 * reports `disconnected` when no surface accepts the payload) — which also
 * yields a per-task delivery ledger this scenario asserts.
 */

import { type IAgentRuntime, Service, ServiceType } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "deterministic-lifeops-concurrent-day";

/** Mirrors DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT in reminders-service.ts. */
const SCHEDULED_TASK_TICK_LIMIT = 25;

// ---------------------------------------------------------------------------
// Synthetic timeline — always in the future relative to the wall clock so the
// injected tick `now` (not the boot clock) controls dueness.
// ---------------------------------------------------------------------------

function nextUtcWeekdayAt(
  weekday: number,
  hourUtc: number,
  minDaysAhead: number,
): Date {
  const base = new Date();
  base.setUTCHours(hourUtc, 0, 0, 0);
  let candidate = new Date(base);
  candidate.setUTCDate(candidate.getUTCDate() + minDaysAhead);
  for (let i = 0; i <= 7; i += 1) {
    if (candidate.getUTCDay() === weekday) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  return candidate;
}

// Tick 1 lands on a Wednesday (UTC day 3) so the weekday_only gate below —
// which only allows Sundays — denies deterministically.
const TICK1_AT = nextUtcWeekdayAt(3, 15, 3);
const TICK2_AT = new Date(TICK1_AT.getTime() + 60_000);

function dueBeforeTick1(minutes: number): string {
  return new Date(TICK1_AT.getTime() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Task plan. Creation order IS the tick visit order (created_at ASC): the
// three high-priority tasks first, the gate-denied task fourth, 21 medium
// fillers, and the low-priority overflow task LAST so it falls past the
// 25-task budget on tick 1.
// ---------------------------------------------------------------------------

interface SeedTaskPlan {
  key: string;
  kind: "reminder" | "checkin" | "approval";
  priority: "low" | "medium" | "high";
  promptInstructions: string;
  dueAtIso: string;
  gateDenied?: boolean;
}

const TASK_PLAN: SeedTaskPlan[] = [
  {
    key: "approval-wire",
    kind: "approval",
    priority: "high",
    promptInstructions: "Approve the pending wire transfer to the landlord",
    dueAtIso: dueBeforeTick1(10),
  },
  {
    key: "midday-checkin",
    kind: "checkin",
    priority: "high",
    promptInstructions: "Midday check-in: how is the day going?",
    dueAtIso: dueBeforeTick1(9),
  },
  {
    key: "medication",
    kind: "reminder",
    priority: "high",
    promptInstructions: "Take the afternoon medication",
    dueAtIso: dueBeforeTick1(8),
  },
  {
    key: "sunday-only",
    kind: "reminder",
    priority: "medium",
    promptInstructions: "Water the garden (Sundays only)",
    dueAtIso: dueBeforeTick1(7),
    gateDenied: true,
  },
  ...Array.from({ length: 21 }, (_, index): SeedTaskPlan => {
    return {
      key: `filler-${String(index + 1).padStart(2, "0")}`,
      kind: "reminder",
      priority: "medium",
      promptInstructions: `Hydration block ${index + 1}: drink a glass of water`,
      dueAtIso: dueBeforeTick1(6),
    };
  }),
  {
    key: "overflow-low",
    kind: "reminder",
    priority: "low",
    promptInstructions: "Stretch break (low priority, past the tick budget)",
    dueAtIso: dueBeforeTick1(5),
  },
];

const OVERFLOW_INDEX = TASK_PLAN.length - 1;
const GATE_DENIED_INDEX = TASK_PLAN.findIndex((task) => task.gateDenied);

/** taskIds in creation order, filled by the seed. */
const seededTaskIds: string[] = [];
let seededRunner: RunnerHandleLike | null = null;

// ---------------------------------------------------------------------------
// Structural runtime typing — the runner host service registered by
// @elizaos/plugin-scheduling with PA's production (DB-backed) deps injected.
// ---------------------------------------------------------------------------

interface ScheduledTaskLike {
  taskId: string;
  kind: string;
  promptInstructions: string;
  priority: string;
  state: { status: string; firedAt?: string };
  metadata?: JsonRecord;
}

interface RunnerHandleLike {
  schedule(input: JsonRecord): Promise<ScheduledTaskLike>;
  list(filter?: JsonRecord): Promise<ScheduledTaskLike[]>;
  apply(
    taskId: string,
    verb: string,
    payload?: JsonRecord,
  ): Promise<ScheduledTaskLike>;
}

interface RunnerServiceLike {
  getRunner(opts: { agentId: string }): RunnerHandleLike;
}

interface RuntimeLike {
  agentId: string;
  getService?: (serviceType: string) => unknown;
  registerService?: (serviceDef: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Real NOTIFICATION delivery surface. The production in_app dispatcher only
// reports `ok` when a real surface (assistant event bus or notification
// service) accepts the payload; a bare scenario runtime has neither, so
// every fire would honestly defer as `dispatch_deferred(disconnected)`.
// Registering this sink makes delivery real AND gives the scenario a
// checkable ledger of what actually reached the owner surface.
// ---------------------------------------------------------------------------

interface CapturedNotification {
  title?: string;
  body?: string;
  category?: string;
  priority?: string;
  data?: JsonRecord;
}

const deliveredNotifications: CapturedNotification[] = [];

class ScenarioNotificationSink extends Service {
  static override serviceType = ServiceType.NOTIFICATION;
  override capabilityDescription =
    "Scenario-owned NOTIFICATION service: captures every delivered payload so the scenario can assert real deliveries.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScenarioNotificationSink> {
    return new ScenarioNotificationSink(runtime);
  }

  override async stop(): Promise<void> {}

  async notify(input: CapturedNotification): Promise<{ ok: true }> {
    deliveredNotifications.push(input);
    return { ok: true };
  }
}

async function ensureNotificationSink(
  runtime: RuntimeLike,
): Promise<string | undefined> {
  const existing = runtime.getService?.(ServiceType.NOTIFICATION);
  if (existing) return undefined;
  if (typeof runtime.registerService !== "function") {
    return "runtime.registerService unavailable; cannot register the notification sink";
  }
  await runtime.registerService(ScenarioNotificationSink);
  // Registration is lazy — force the instance to start so the dispatcher's
  // synchronous getService(NOTIFICATION) sees a live surface on tick 1.
  await runtime.getServiceLoadPromise?.(ServiceType.NOTIFICATION);
  if (!runtime.getService?.(ServiceType.NOTIFICATION)) {
    return "notification sink did not start; in_app dispatch would honestly report disconnected";
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

async function seedConcurrentDayTasks(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  seededTaskIds.length = 0;
  deliveredNotifications.length = 0;
  const runtime = ctx.runtime as RuntimeLike | undefined;
  const service = runtime?.getService?.("lifeops_scheduled_task_runner") as
    | RunnerServiceLike
    | null
    | undefined;
  if (!runtime || !service || typeof service.getRunner !== "function") {
    return "ScheduledTaskRunnerService is not registered on the scenario runtime";
  }
  const sinkFailure = await ensureNotificationSink(runtime);
  if (sinkFailure) return sinkFailure;
  const runner = service.getRunner({ agentId: runtime.agentId });
  seededRunner = runner;

  // The CLI shares one runtime across every scenario in a run, so the store
  // may hold rows from earlier scenarios. Park any live foreign row in
  // `dismissed` (never refires, drops out of the tick's indexed slice) so
  // this scenario's ledger math over the 25-task budget stays exact.
  const preExisting = await runner.list();
  for (const task of preExisting) {
    if (!TERMINAL_STATUSES.has(task.state.status)) {
      await runner.apply(task.taskId, "dismiss", {
        reason: `${SCENARIO_ID}: quiescing shared-runtime store before exact-ledger ticks`,
      });
    }
  }

  for (const plan of TASK_PLAN) {
    const created = await runner.schedule({
      kind: plan.kind,
      promptInstructions: plan.promptInstructions,
      trigger: { kind: "once", atIso: plan.dueAtIso },
      priority: plan.priority,
      ...(plan.gateDenied
        ? {
            shouldFire: {
              gates: [{ kind: "weekday_only", params: { weekdays: [0] } }],
            },
          }
        : {}),
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: SCENARIO_ID,
      ownerVisible: true,
      idempotencyKey: `${SCENARIO_ID}:${plan.key}`,
      metadata: { scenario: SCENARIO_ID, planKey: plan.key },
    });
    seededTaskIds.push(created.taskId);
    // created_at has millisecond resolution; strictly increasing timestamps
    // make the tick's `ORDER BY created_at ASC` visit order deterministic.
    await sleep(3);
  }

  if (seededTaskIds.length !== TASK_PLAN.length) {
    return `expected ${TASK_PLAN.length} seeded tasks, saw ${seededTaskIds.length}`;
  }
  return undefined;
}

async function dismissSeededTasks(): Promise<string | undefined> {
  if (!seededRunner) return undefined;
  for (const taskId of seededTaskIds) {
    await seededRunner.apply(taskId, "dismiss", {
      reason: `${SCENARIO_ID}: cleanup`,
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tick-body readers
// ---------------------------------------------------------------------------

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
}

function readTickBody(body: unknown):
  | {
      fires: FireEntry[];
      completionTimeouts: FireEntry[];
      subsystemFailures: JsonRecord[];
    }
  | string {
  if (!isRecord(body)) {
    return `expected tick response object, saw ${JSON.stringify(body)}`;
  }
  if (body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body.success)}`;
  }
  const readEntries = (value: unknown, label: string): FireEntry[] | string => {
    if (!Array.isArray(value)) return `expected ${label} array`;
    const entries: FireEntry[] = [];
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        typeof entry.taskId !== "string" ||
        typeof entry.status !== "string" ||
        typeof entry.reason !== "string"
      ) {
        return `malformed ${label} entry: ${JSON.stringify(entry)}`;
      }
      entries.push({
        taskId: entry.taskId,
        status: entry.status,
        reason: entry.reason,
        ...(typeof entry.occurrenceAtIso === "string"
          ? { occurrenceAtIso: entry.occurrenceAtIso }
          : {}),
      });
    }
    return entries;
  };
  const fires = readEntries(body.scheduledTaskFires, "scheduledTaskFires");
  if (typeof fires === "string") return fires;
  const completionTimeouts = readEntries(
    body.scheduledTaskCompletionTimeouts,
    "scheduledTaskCompletionTimeouts",
  );
  if (typeof completionTimeouts === "string") return completionTimeouts;
  const subsystemFailures = Array.isArray(body.subsystemFailures)
    ? body.subsystemFailures.filter(isRecord)
    : [];
  const scheduledTasksFailure = subsystemFailures.find(
    (failure) => failure.subsystem === "scheduled_tasks",
  );
  if (scheduledTasksFailure) {
    return `scheduled_tasks subsystem failed: ${JSON.stringify(scheduledTasksFailure)}`;
  }
  return { fires, completionTimeouts, subsystemFailures };
}

const tick1Fires: FireEntry[] = [];
const tick2Fires: FireEntry[] = [];

async function assertTick1(
  _status: number,
  body: unknown,
): Promise<string | undefined> {
  tick1Fires.length = 0;
  const tick = readTickBody(body);
  if (typeof tick === "string") return tick;
  tick1Fires.push(...tick.fires);

  if (tick.fires.length !== SCHEDULED_TASK_TICK_LIMIT) {
    return `expected the tick budget of exactly ${SCHEDULED_TASK_TICK_LIMIT} ledger entries, saw ${tick.fires.length}`;
  }
  if (tick.completionTimeouts.length !== 0) {
    return `expected no completion timeouts on tick 1, saw ${JSON.stringify(tick.completionTimeouts)}`;
  }

  // Visit order is created_at ASC: the ledger must list the first 25 seeded
  // taskIds in exactly their creation order.
  const expectedIds = seededTaskIds.slice(0, SCHEDULED_TASK_TICK_LIMIT);
  const actualIds = tick.fires.map((fire) => fire.taskId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    return `tick 1 ledger order != creation order.\n  expected ${JSON.stringify(expectedIds)}\n  saw      ${JSON.stringify(actualIds)}`;
  }

  // High-priority tasks (seeded first) fired first.
  for (let index = 0; index < 3; index += 1) {
    const fire = tick.fires[index];
    if (fire?.status !== "fired" || fire.reason !== "once_due") {
      return `expected high-priority ${TASK_PLAN[index]?.key} at ledger position ${index} to be fired(once_due), saw ${JSON.stringify(fire)}`;
    }
  }

  // Per-task state: the gate-blocked task is recorded as skipped with the
  // weekday_only denial reason; every other visited task fired via once_due.
  for (const [index, fire] of tick.fires.entries()) {
    if (index === GATE_DENIED_INDEX) {
      if (fire.status !== "skipped" || !fire.reason.includes("weekday_only")) {
        return `expected gate-denied task to be skipped with a weekday_only reason, saw ${JSON.stringify(fire)}`;
      }
      continue;
    }
    if (fire.status !== "fired" || fire.reason !== "once_due") {
      return `expected ${TASK_PLAN[index]?.key} to be fired(once_due), saw ${JSON.stringify(fire)}`;
    }
    if (fire.occurrenceAtIso !== TASK_PLAN[index]?.dueAtIso) {
      return `expected ${TASK_PLAN[index]?.key} occurrenceAtIso=${TASK_PLAN[index]?.dueAtIso}, saw ${fire.occurrenceAtIso}`;
    }
  }

  // The overflow low-priority task is past the budget: absent from tick 1.
  const overflowId = seededTaskIds[OVERFLOW_INDEX];
  if (actualIds.includes(overflowId ?? "")) {
    return `overflow task ${overflowId} must not be visited on tick 1`;
  }

  // "None lost": between ticks the task past the budget is still `scheduled`
  // in the store — deferred, not dropped.
  if (!seededRunner) return "seeded runner unavailable";
  const stillScheduled = await seededRunner.list({ status: "scheduled" });
  const overflow = stillScheduled.find((task) => task.taskId === overflowId);
  return overflow
    ? undefined
    : `expected overflow task ${overflowId} to remain scheduled after tick 1`;
}

function assertTick2(_status: number, body: unknown): string | undefined {
  tick2Fires.length = 0;
  const tick = readTickBody(body);
  if (typeof tick === "string") return tick;
  tick2Fires.push(...tick.fires);

  const overflowId = seededTaskIds[OVERFLOW_INDEX];
  if (tick.fires.length !== 1) {
    return `expected exactly the deferred overflow task on tick 2, saw ${JSON.stringify(tick.fires)}`;
  }
  const fire = tick.fires[0];
  if (
    fire?.taskId !== overflowId ||
    fire.status !== "fired" ||
    fire.reason !== "once_due"
  ) {
    return `expected overflow task ${overflowId} fired(once_due) on tick 2, saw ${JSON.stringify(fire)}`;
  }
  if (tick.completionTimeouts.length !== 0) {
    return `expected no completion timeouts on tick 2, saw ${JSON.stringify(tick.completionTimeouts)}`;
  }
  return undefined;
}

function assertFullLedgerAccounting(): string | undefined {
  // Across both ticks the ledger accounts for every seeded task exactly once.
  const seen = new Map<string, number>();
  for (const fire of [...tick1Fires, ...tick2Fires]) {
    seen.set(fire.taskId, (seen.get(fire.taskId) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const [index, taskId] of seededTaskIds.entries()) {
    const count = seen.get(taskId) ?? 0;
    if (count !== 1) {
      problems.push(
        `${TASK_PLAN[index]?.key} (${taskId}) appeared ${count} times in the fire ledgers (expected exactly 1)`,
      );
    }
  }
  return problems.length === 0 ? undefined : problems.join("; ");
}

function assertRealDeliveries(): string | undefined {
  // Every FIRED task delivered exactly one real notification (body =
  // promptInstructions); the gate-denied task never reached the surface.
  const bodyCounts = new Map<string, number>();
  for (const notification of deliveredNotifications) {
    if (typeof notification.body === "string") {
      bodyCounts.set(
        notification.body,
        (bodyCounts.get(notification.body) ?? 0) + 1,
      );
    }
  }
  const problems: string[] = [];
  for (const [index, plan] of TASK_PLAN.entries()) {
    const delivered = bodyCounts.get(plan.promptInstructions) ?? 0;
    const expected = index === GATE_DENIED_INDEX ? 0 : 1;
    if (delivered !== expected) {
      problems.push(
        `${plan.key}: expected ${expected} delivered notification(s), saw ${delivered}`,
      );
    }
  }
  return problems.length === 0 ? undefined : problems.join("; ");
}

export default scenario({
  id: "deterministic-lifeops-concurrent-day",
  lane: "pr-deterministic",
  title:
    "Concurrent-day scheduler tick: 26 due tasks, exact 25-task budget, ordered ledger, none lost",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "scheduled-tasks",
    "scheduler-tick",
    "concurrency",
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
      name: "seed 26 concurrently-due scheduled tasks through the production runner",
      apply: seedConcurrentDayTasks,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "dismiss seeded tasks so later shared-runtime scenarios see a quiet store",
      apply: dismissSeededTasks,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Deterministic LifeOps Concurrent Day",
    },
  ],
  turns: [
    {
      kind: "tick",
      name: "tick 1: 25-task budget consumed in creation order",
      worker: "lifeops_scheduler",
      options: { now: TICK1_AT.toISOString() },
      expectedStatus: 200,
      assertResponse: assertTick1,
    },
    {
      kind: "tick",
      name: "tick 2: the deferred low-priority task fires (none lost)",
      worker: "lifeops_scheduler",
      options: { now: TICK2_AT.toISOString() },
      expectedStatus: 200,
      assertResponse: assertTick2,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "fire ledgers account for every seeded task exactly once",
      predicate: assertFullLedgerAccounting,
    },
    {
      type: "custom",
      name: "every fired task delivered exactly one real notification; the gate-denied task delivered none",
      predicate: assertRealDeliveries,
    },
  ],
});
