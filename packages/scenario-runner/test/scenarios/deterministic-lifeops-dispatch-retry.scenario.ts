/**
 * Deterministic dispatch-retry coverage for the ScheduledTask spine
 * (#10721 H2 dispatch-policy enforcement, scenario-level).
 *
 * A reminder is scheduled through the REAL REST surface
 * (`POST /api/lifeops/scheduled-tasks`) with `output.destination: "channel"`
 * routed at a scenario-registered probe channel whose `send` returns a TYPED
 * failure (`{ ok: false, reason: "rate_limited", retryAfterMinutes: 10 }`)
 * on the first dispatch and success on the second. The REAL scheduler entry
 * (`executeLifeOpsSchedulerTask` → `processDueScheduledTasks`, via the
 * executor's `tick` turn with an injected `now`) then drives:
 *
 *   tick 1 (task due)      — the fire dispatches, the channel fails typed,
 *                            the policy parks the task back in `scheduled`
 *                            at the retry instant (`dispatch_deferred`,
 *                            reason `retry:rate_limited`), and the state log
 *                            records `dispatch_retried`;
 *   tick 2 (before retry)  — nothing re-attempts early: the parked row is
 *                            indexed AND due only at the retry time;
 *   tick 3 (past retry)    — the same step retries (`scheduled_override_due`),
 *                            the channel delivers, the task lands `fired`.
 *
 * Runs keylessly: no message turns, no LLM calls. The probe channel captures
 * a dispatch ledger asserted exactly (fail-then-deliver, both for this task)
 * and a custom final check reads the REAL DB-backed state log through the
 * runner's injected deps (`getScheduledTaskRunnerDeps`).
 *
 * Fail-without-fix anchor: revert the dispatch-policy enforcement in
 * `plugin-scheduling/src/scheduled-task/runner.ts` (typed `ok:false` results
 * stashed in metadata while the fire reports `"fired"`) and tick 1 records
 * `status: "fired"` with no `dispatch_retried` transition — the tick-1
 * assertion and both final checks fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "deterministic-lifeops-dispatch-retry";
const PROBE_CHANNEL_KIND = "scenario_probe";
const PROBE_PROMPT = "Deterministic dispatch-retry probe reminder";
const RETRY_AFTER_MINUTES = 10;

// ---------------------------------------------------------------------------
// Synthetic timeline — minutes ahead of the wall clock so only the injected
// tick `now` controls dueness.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const BASE = new Date(Math.floor(Date.now() / 1000) * 1000);
const DUE_AT = new Date(BASE.getTime() + 30 * MINUTE_MS);
const TICK_FAIL = new Date(BASE.getTime() + 31 * MINUTE_MS);
const RETRY_AT = new Date(
  TICK_FAIL.getTime() + RETRY_AFTER_MINUTES * MINUTE_MS,
);
const TICK_EARLY = new Date(RETRY_AT.getTime() - 2 * MINUTE_MS);
const TICK_RETRY = new Date(BASE.getTime() + 45 * MINUTE_MS);

// ---------------------------------------------------------------------------
// Probe channel — typed failure first, delivery second. Module state is reset
// by the seed so reruns inside a shared process stay deterministic.
// ---------------------------------------------------------------------------

type ProbeDispatchResult =
  | {
      ok: false;
      reason: "rate_limited";
      retryAfterMinutes: number;
      userActionable: false;
    }
  | { ok: true; messageId: string };

interface ProbeDispatch {
  payload: unknown;
  result: ProbeDispatchResult;
}

const probeQueue: ProbeDispatchResult[] = [];
const probeLedger: ProbeDispatch[] = [];
let probeTaskId: string | null = null;
let scenarioRuntime: RuntimeLike | null = null;

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
  send?(payload: unknown): Promise<ProbeDispatchResult>;
}

interface ChannelRegistryLike {
  register(contribution: ChannelContributionLike): void;
  get(kind: string): ChannelContributionLike | null;
}

interface RunnerHandleLike {
  apply(taskId: string, verb: string, payload?: JsonRecord): Promise<unknown>;
}

interface RunnerServiceLike {
  getRunner(opts: { agentId: string }): RunnerHandleLike;
}

interface RuntimeLike {
  agentId: string;
  channelRegistry?: ChannelRegistryLike;
  getService?: (serviceType: string) => unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seedProbeChannel(ctx: ScenarioContext): string | undefined {
  probeQueue.length = 0;
  probeLedger.length = 0;
  probeTaskId = null;

  const runtime = ctx.runtime as RuntimeLike | undefined;
  const registry = runtime?.channelRegistry;
  if (!runtime || !registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  scenarioRuntime = runtime;

  probeQueue.push(
    {
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: RETRY_AFTER_MINUTES,
      userActionable: false,
    },
    { ok: true, messageId: `${SCENARIO_ID}-delivered-1` },
  );

  // The CLI shares one runtime across a run; registering twice throws, so
  // only the first execution installs the channel. The queue/ledger above are
  // module state and reset every run either way.
  if (!registry.get(PROBE_CHANNEL_KIND)) {
    registry.register({
      kind: PROBE_CHANNEL_KIND,
      describe: { label: "Scenario dispatch-retry probe" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(payload: unknown): Promise<ProbeDispatchResult> {
        const result = probeQueue.shift() ?? {
          ok: false as const,
          reason: "rate_limited" as const,
          retryAfterMinutes: RETRY_AFTER_MINUTES,
          userActionable: false as const,
        };
        probeLedger.push({ payload, result });
        return result;
      },
    });
  }
  return undefined;
}

async function dismissProbeTask(): Promise<string | undefined> {
  if (!scenarioRuntime || !probeTaskId) return undefined;
  const service = scenarioRuntime.getService?.(
    "lifeops_scheduled_task_runner",
  ) as RunnerServiceLike | null | undefined;
  if (!service || typeof service.getRunner !== "function") return undefined;
  const runner = service.getRunner({ agentId: scenarioRuntime.agentId });
  await runner.apply(probeTaskId, "dismiss", {
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
  occurrenceAtIso?: string;
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
      ...(typeof entry.occurrenceAtIso === "string"
        ? { occurrenceAtIso: entry.occurrenceAtIso }
        : {}),
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

function probeFires(body: unknown): FireEntry[] | string {
  const fires = readTickFires(body);
  if (typeof fires === "string") return fires;
  if (!probeTaskId) return "probe taskId was not captured from the create turn";
  return fires.filter((fire) => fire.taskId === probeTaskId);
}

function assertCreated(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  probeTaskId = task.taskId;
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected created task.state.status=scheduled, saw ${JSON.stringify(state?.status)}`;
  }
  const output = isRecord(task.output) ? task.output : null;
  if (
    output?.destination !== "channel" ||
    output.target !== `${PROBE_CHANNEL_KIND}:owner`
  ) {
    return `expected output routed at the probe channel, saw ${JSON.stringify(task.output)}`;
  }
  return undefined;
}

function assertFailTick(_status: number, body: unknown): string | undefined {
  const fires = probeFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one probe ledger entry on the failing tick, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "scheduled") {
    return `expected the typed dispatch failure to park the task back in scheduled, saw status=${JSON.stringify(fire?.status)}`;
  }
  if (fire.reason !== "retry:rate_limited") {
    return `expected reason retry:rate_limited, saw ${JSON.stringify(fire.reason)}`;
  }
  if (fire.occurrenceAtIso !== RETRY_AT.toISOString()) {
    return `expected next attempt at ${RETRY_AT.toISOString()}, saw ${JSON.stringify(fire.occurrenceAtIso)}`;
  }
  if (probeLedger.length !== 1 || probeLedger[0]?.result.ok !== false) {
    return `expected exactly one failed probe dispatch by tick 1, saw ${JSON.stringify(probeLedger)}`;
  }
  return undefined;
}

function assertParkedHistory(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body)) return `expected history object, saw ${typeof body}`;
  if (body.taskId !== probeTaskId) {
    return `expected history for ${probeTaskId}, saw ${JSON.stringify(body.taskId)}`;
  }
  if (body.status !== "scheduled") {
    return `expected parked status=scheduled, saw ${JSON.stringify(body.status)}`;
  }
  if (body.firedAt !== RETRY_AT.toISOString()) {
    return `expected the parked row to carry the retry instant firedAt=${RETRY_AT.toISOString()}, saw ${JSON.stringify(body.firedAt)}`;
  }
  const expectedLog = `dispatch retry 1/3 in ${RETRY_AFTER_MINUTES}m (rate_limited)`;
  if (body.lastDecisionLog !== expectedLog) {
    return `expected lastDecisionLog ${JSON.stringify(expectedLog)}, saw ${JSON.stringify(body.lastDecisionLog)}`;
  }
  return undefined;
}

function assertEarlyTick(_status: number, body: unknown): string | undefined {
  const fires = probeFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 0) {
    return `the parked retry must not re-attempt before the retry instant, saw ${JSON.stringify(fires)}`;
  }
  if (probeLedger.length !== 1) {
    return `expected no probe dispatch before the retry instant, saw ${probeLedger.length}`;
  }
  return undefined;
}

function assertRetryTick(_status: number, body: unknown): string | undefined {
  const fires = probeFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one probe ledger entry on the retry tick, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired") {
    return `expected the retry to deliver and land fired, saw ${JSON.stringify(fire)}`;
  }
  if (fire.reason !== "scheduled_override_due") {
    return `expected the retry to fire via scheduled_override_due, saw ${JSON.stringify(fire.reason)}`;
  }
  if (probeLedger.length !== 2 || probeLedger[1]?.result.ok !== true) {
    return `expected the second probe dispatch to deliver, saw ${JSON.stringify(probeLedger)}`;
  }
  return undefined;
}

function assertFiredHistory(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body)) return `expected history object, saw ${typeof body}`;
  if (body.status !== "fired") {
    return `expected final status=fired, saw ${JSON.stringify(body.status)}`;
  }
  if (body.firedAt !== TICK_RETRY.toISOString()) {
    return `expected firedAt=${TICK_RETRY.toISOString()}, saw ${JSON.stringify(body.firedAt)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Final checks
// ---------------------------------------------------------------------------

function assertProbeLedger(): string | undefined {
  if (probeLedger.length !== 2) {
    return `expected exactly 2 probe dispatches (fail, deliver), saw ${probeLedger.length}`;
  }
  const [first, second] = probeLedger;
  if (
    first?.result.ok !== false ||
    first.result.reason !== "rate_limited" ||
    first.result.retryAfterMinutes !== RETRY_AFTER_MINUTES
  ) {
    return `expected the first dispatch to fail typed rate_limited, saw ${JSON.stringify(first?.result)}`;
  }
  if (second?.result.ok !== true) {
    return `expected the second dispatch to deliver, saw ${JSON.stringify(second?.result)}`;
  }
  for (const [index, dispatch] of probeLedger.entries()) {
    const payload = isRecord(dispatch.payload) ? dispatch.payload : null;
    const metadata = isRecord(payload?.metadata) ? payload.metadata : null;
    if (metadata?.taskId !== probeTaskId) {
      return `dispatch ${index} was not for the probe task: ${JSON.stringify(payload)}`;
    }
    if (payload?.message !== PROBE_PROMPT) {
      return `dispatch ${index} carried the wrong message: ${JSON.stringify(payload?.message)}`;
    }
  }
  return undefined;
}

async function assertStateLog(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!probeTaskId) return "probe taskId was not captured";
  const { getScheduledTaskRunnerDeps } = await import(
    "@elizaos/plugin-scheduling"
  );
  const runtime = ctx.runtime as unknown as Parameters<
    typeof getScheduledTaskRunnerDeps
  >[0];
  const provider = getScheduledTaskRunnerDeps(runtime);
  if (!provider) return "scheduled-task runner deps provider is not registered";
  const deps = provider(runtime, (ctx.runtime as RuntimeLike).agentId);
  const rows = await deps.logStore.list({
    agentId: (ctx.runtime as RuntimeLike).agentId,
    taskId: probeTaskId,
  });
  const transitions = rows.map((row) => row.transition);
  const retriedIndex = transitions.indexOf("dispatch_retried");
  if (retriedIndex === -1) {
    return `expected a dispatch_retried state-log transition, saw [${transitions.join(", ")}]`;
  }
  const firedIndex = transitions.lastIndexOf("fired");
  if (firedIndex === -1 || firedIndex < retriedIndex) {
    return `expected fired AFTER dispatch_retried, saw [${transitions.join(", ")}]`;
  }
  const retried = rows[retriedIndex];
  const detail = isRecord(retried?.detail) ? retried.detail : null;
  if (
    detail?.attempt !== 1 ||
    detail.retryAfterMinutes !== RETRY_AFTER_MINUTES ||
    detail.nextAttemptAtIso !== RETRY_AT.toISOString()
  ) {
    return `dispatch_retried detail mismatch: ${JSON.stringify(retried?.detail)}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-lifeops-dispatch-retry",
  lane: "pr-deterministic",
  title:
    "Typed dispatch failure parks the fire for retry, then delivers at the retry instant",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "scheduled-tasks",
    "dispatch-policy",
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
      name: "register the failing-then-delivering probe channel",
      apply: seedProbeChannel,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "dismiss the probe task",
      apply: dismissProbeTask,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "schedule the probe reminder over REST",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: PROBE_PROMPT,
        trigger: { kind: "once", atIso: DUE_AT.toISOString() },
        priority: "low",
        output: {
          destination: "channel",
          target: `${PROBE_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-probe`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { probeTaskId: "task.taskId" },
      assertResponse: assertCreated,
    },
    {
      kind: "tick",
      name: "tick at dueness — dispatch fails typed and parks the retry",
      worker: "lifeops_scheduler",
      options: { now: TICK_FAIL.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFailTick,
    },
    {
      kind: "api",
      name: "parked row is scheduled at the retry instant",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks/{{capture:probeTaskId}}/history",
      expectedStatus: 200,
      assertResponse: assertParkedHistory,
    },
    {
      kind: "tick",
      name: "tick before the retry instant — nothing re-attempts early",
      worker: "lifeops_scheduler",
      options: { now: TICK_EARLY.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertEarlyTick,
    },
    {
      kind: "tick",
      name: "tick past the retry instant — the retry delivers",
      worker: "lifeops_scheduler",
      options: { now: TICK_RETRY.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertRetryTick,
    },
    {
      kind: "api",
      name: "delivered task landed fired",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks/{{capture:probeTaskId}}/history",
      expectedStatus: 200,
      assertResponse: assertFiredHistory,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "probe channel ledger is exactly fail-then-deliver for this task",
      predicate: assertProbeLedger,
    },
    {
      type: "custom",
      name: "state log records dispatch_retried before the final fired",
      predicate: assertStateLog,
    },
  ],
});
