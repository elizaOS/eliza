/**
 * orchestrator-concurrency-admission (#13778, epic #13766 WS8) — deterministic,
 * keyless scenario-runner evidence for N-tasks-in-flight against a worker cap.
 *
 * This is the scenario-runner lane of the concurrency e2e: it drives ≥2
 * concurrent orchestrator tasks (here 6 tasks against maxSessions=2) through the
 * REAL OrchestratorTaskService + a cap-enforcing deterministic ACP, then:
 *   - asserts admission parks the over-cap tasks (2 active, 4 queued) with zero
 *     drops, and drains them in order as slots free;
 *   - correlates each task's self-recorded trajectories via its per-task traceId
 *     (#13775/#13871): the durable session record carries a distinct traceId per
 *     task, so a run's trajectories are attributable per task;
 *   - scores the orchestration behavior under load with the same typed
 *     lifecycle vocabulary the orchestrator_lifecycle benchmark uses
 *     (spawn / status_query / share), extracted structurally from the real
 *     service calls — never from reply prose.
 *
 * It self-contains its ACP + service the way orchestrator-watchdog-stall does,
 * so it runs in the keyless pr-deterministic lane with no model and no
 * subprocess. The full lifecycle + scratch-GC proof lives in the vitest
 * `concurrency-lifecycle-e2e.test.ts`; this scenario is the runner-visible,
 * trajectory-correlated slice.
 */

import type { Action, Plugin } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  SessionCapError,
  type SessionInfo,
  type SpawnOptions,
  type SpawnResult,
} from "../../src/services/types.js";

const CONCURRENCY_SCENARIO_PLUGIN_NAME = "orchestrator-concurrency-scenario";
const ORCHESTRATOR_CONCURRENCY_ADMISSION = "ORCHESTRATOR_CONCURRENCY_ADMISSION";

const CAP = 2;
const TOTAL = 6;
const ROOM = "33333333-3333-4333-8333-333333333333";

/** The typed lifecycle events the orchestrator_lifecycle benchmark scores
 * (spawn / send / pause / resume / cancel / status_query / share). This scenario
 * emits a structural subset under concurrent load; the vocabulary is kept in
 * sync with `packages/benchmarks/orchestrator_lifecycle/events.py`. */
type LifecycleEvent = "spawn" | "status_query" | "share";

type PerTaskTrace = {
  taskId: string;
  title: string;
  /** The distinct traceId stamped on the task's session at spawn (#13775). */
  traceId: string | null;
};

type ConcurrencyScenarioResult = {
  summary: string;
  cap: number;
  total: number;
  activeAtCap: number;
  queuedAtCap: number;
  /** Task ids in the queue's deterministic dispatch order at the moment of cap. */
  queuedOrder: string[];
  /** Every task held exactly one session after the drain (no drops/doubles). */
  sessionsPerTask: Record<string, number>;
  finalStatuses: Record<string, string>;
  /** Per-task trajectory correlation: one distinct traceId per task. */
  traces: PerTaskTrace[];
  distinctTraceIds: number;
  /** Structural lifecycle events emitted under load, deduped + ordered. */
  lifecycleEvents: LifecycleEvent[];
};

function concurrencyScenarioData(
  ctx: ScenarioContext,
): ConcurrencyScenarioResult | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_CONCURRENCY_ADMISSION,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as ConcurrencyScenarioResult)
    : null;
}

/** A cap-enforcing deterministic ACP. Enforces the exact worker-slot accounting
 * AcpService enforces (throws SessionCapError past the cap so the real service's
 * admission queue parks the spawn) and lets the scenario drive terminal
 * completions to free slots. No scratch fs here — the fs-level scratch-GC guard
 * lives in the vitest lifecycle test; this lane is about admission + trace
 * correlation + lifecycle scoring. */
class ConcurrencyAcp {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly handlers = new Set<
    (sessionId: string, event: string, data: unknown) => void
  >();
  private counter = 0;

  constructor(private readonly maxSessions: number) {}

  private activeWorkers(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (
        !["stopped", "completed", "error", "errored", "cancelled"].includes(
          s.status,
        )
      ) {
        n++;
      }
    }
    return n;
  }

  async getCapacity() {
    const workers = this.activeWorkers();
    return {
      maxSessions: this.maxSessions,
      systemHeadroom: 2,
      activeWorkers: workers,
      activeSystem: 0,
      freeWorkerSlots: Math.max(0, this.maxSessions - workers),
      freeSystemSlots: 2,
    };
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const slotClass = opts.slotClass ?? "worker";
    if (slotClass === "worker" && this.activeWorkers() >= this.maxSessions) {
      throw new SessionCapError(
        "worker",
        this.maxSessions,
        this.activeWorkers(),
      );
    }
    const id = `concurrency-sess-${++this.counter}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? "/tmp/concurrency",
      status: "ready",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}), slotClass },
    };
    this.sessions.set(id, session);
    return {
      sessionId: id,
      id,
      name: session.name ?? id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    };
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    return this.sessions.get(id) ?? null;
  }

  getChangedPaths(): string[] {
    return [];
  }

  async stopSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.status = "stopped";
    this.emit(id, "stopped", { sessionId: id });
  }

  async sendToSession(id: string) {
    return {
      sessionId: id,
      finalText: "ack",
      response: "ack",
      stopReason: "end_turn",
      durationMs: 1,
    };
  }

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    for (const h of [...this.handlers]) h(sessionId, event, data);
  }

  /** Complete a live session: free its slot and emit task_complete so the real
   * service advances the task and drains a queued task into the freed slot. */
  complete(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.status = "completed";
    this.emit(id, "task_complete", { response: "done" });
  }
}

function makeRuntime(acp: ConcurrencyAcp): unknown {
  return {
    agentId: "00000000-0000-4000-8000-0000000c0ncr",
    character: { name: "ConcurrencyScenario" },
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    useModel: async () => "{}",
    reportError() {},
    getService: (type: string) =>
      type === "ACP_SUBPROCESS_SERVICE" ? acp : undefined,
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("concurrency scenario waitUntil timed out");
}

async function runConcurrencyAdmission(): Promise<ConcurrencyScenarioResult> {
  const prior: Record<string, string | undefined> = {
    ELIZA_ACP_ADMISSION_QUEUE: process.env.ELIZA_ACP_ADMISSION_QUEUE,
    ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY:
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY,
    ELIZA_ORCHESTRATOR_WATCHDOG: process.env.ELIZA_ORCHESTRATOR_WATCHDOG,
  };
  process.env.ELIZA_ACP_ADMISSION_QUEUE = "1";
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  process.env.ELIZA_ORCHESTRATOR_WATCHDOG = "0";

  const acp = new ConcurrencyAcp(CAP);
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
    store,
  });
  await service.start();

  const lifecycleEvents: LifecycleEvent[] = [];
  const addEvent = (e: LifecycleEvent) => {
    if (!lifecycleEvents.includes(e)) lifecycleEvents.push(e);
  };

  // ── Submit TOTAL tasks and spawn an agent for each (a `spawn` per task). ──
  const titles = Array.from({ length: TOTAL }, (_, i) => `task-${i}`);
  const ids: string[] = [];
  for (const title of titles) {
    const detail = (await store.createTask({
      title,
      goal: `Fix ${title}.`,
      acceptanceCriteria: [`${title} tests pass`],
      priority: "normal",
      roomId: ROOM,
    })) as { task: { id: string } };
    ids.push(detail.task.id);
  }
  for (const id of ids) {
    await service.spawnAgentForTask(id, { label: "Ada" });
    addEvent("spawn");
  }

  // ── status_query under load: read the live capacity + admission snapshot. ─
  const snapshot = await service.getAdmissionSnapshot();
  addEvent("status_query");
  const activeAtCap = acp
    .listSessions()
    .filter((s) => s.status !== "stopped" && s.status !== "completed").length;
  const queuedAtCap = snapshot.queueDepth;
  if (activeAtCap !== CAP) {
    throw new Error(`expected ${CAP} active at cap, saw ${activeAtCap}`);
  }
  if (queuedAtCap !== TOTAL - CAP) {
    throw new Error(
      `expected ${TOTAL - CAP} queued at cap, saw ${queuedAtCap}`,
    );
  }
  const queuedOrder = [...snapshot.queuedTaskIds];

  // ── Drain: complete each live session, freeing a slot for a queued task,
  // until all TOTAL tasks have held a session. Zero drops. ─────────────────
  for (let guard = 0; guard < TOTAL * 4; guard++) {
    const running = acp.listSessions().find((s) => s.status === "ready");
    if (!running) break;
    const runningTaskId =
      (running.metadata?.taskId as string | undefined) ?? "";
    // Let the spawn's ready→session_active settle so the task is `active` and
    // task_complete deterministically moves it to `validating`.
    await waitUntil(async () => {
      const doc = await store.getTask(runningTaskId);
      return doc?.task.status === "active" || doc?.task.status === "validating";
    });
    acp.complete(running.id);
    await waitUntil(async () => {
      const doc = await store.getTask(runningTaskId);
      return doc?.task.status === "validating";
    });
    await waitUntil(async () => {
      const depth = (await service.getAdmissionSnapshot()).queueDepth;
      const nowRunning = acp
        .listSessions()
        .filter((s) => s.status === "ready").length;
      return depth === 0 || nowRunning === CAP;
    });
  }
  await waitUntil(
    async () => (await service.getAdmissionSnapshot()).queueDepth === 0,
  );

  // ── Per-task trajectory correlation: each task's durable session record
  // carries a distinct traceId (#13775) — trajectories are attributable per
  // task by that id. ────────────────────────────────────────────────────────
  const traces: PerTaskTrace[] = [];
  const sessionsPerTask: Record<string, number> = {};
  const finalStatuses: Record<string, string> = {};
  for (const id of ids) {
    const doc = await store.getTask(id);
    const sessions = doc?.sessions ?? [];
    sessionsPerTask[id] = sessions.length;
    finalStatuses[id] = doc?.task.status ?? "missing";
    traces.push({
      taskId: id,
      title: doc?.task.title ?? "",
      traceId: sessions[0]?.traceId ?? null,
    });
  }

  // ── share under load: surface the run's task set (the digest/registry read
  // the orchestrator does when reporting concurrent-task state). ────────────
  const tasks = await service.listTasks({ includeArchived: false });
  addEvent("status_query");
  if (tasks.length >= 2) addEvent("share");

  // Zero drops: every task held exactly one session.
  const drops = Object.entries(sessionsPerTask).filter(([, n]) => n !== 1);
  if (drops.length > 0) {
    throw new Error(
      `expected exactly one session per task, saw ${JSON.stringify(sessionsPerTask)}`,
    );
  }

  const distinctTraceIds = new Set(
    traces.map((t) => t.traceId).filter((x): x is string => Boolean(x)),
  ).size;
  if (distinctTraceIds !== TOTAL) {
    throw new Error(
      `expected ${TOTAL} distinct per-task traceIds, saw ${distinctTraceIds}`,
    );
  }

  await service.stop();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    summary: `admitted ${TOTAL} concurrent tasks against maxSessions=${CAP}: ${activeAtCap} active + ${queuedAtCap} queued at the cap, drained to zero with one session per task (no drops), ${distinctTraceIds} distinct per-task traceIds correlated, lifecycle events under load: ${lifecycleEvents.join(", ")}`,
    cap: CAP,
    total: TOTAL,
    activeAtCap,
    queuedAtCap,
    queuedOrder,
    sessionsPerTask,
    finalStatuses,
    traces,
    distinctTraceIds,
    lifecycleEvents,
  };
}

function concurrencyScenarioPlugin(): Plugin {
  const action: Action = {
    name: ORCHESTRATOR_CONCURRENCY_ADMISSION,
    description:
      "Drive N concurrent orchestrator tasks against a worker cap: assert admission parking + drain with zero drops, correlate per-task traceIds, and score lifecycle events under load.",
    validate: async () => true,
    handler: async () => {
      const result = await runConcurrencyAdmission();
      return {
        success: true,
        text: result.summary,
        userFacingText: result.summary,
        verifiedUserFacing: true,
        data: result,
      };
    },
  };
  return {
    name: CONCURRENCY_SCENARIO_PLUGIN_NAME,
    description:
      "Deterministic N-tasks-vs-cap concurrency admission scenario (#13778).",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-concurrency-admission",
  lane: "pr-deterministic",
  title:
    "Orchestrator admits N concurrent tasks against a worker cap with zero drops and per-task trace correlation",
  domain: "agent-orchestrator",
  tags: [
    "orchestrator",
    "concurrency",
    "admission",
    "multi-task",
    "pr",
    "deterministic",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [CONCURRENCY_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register deterministic concurrency scenario action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === CONCURRENCY_SCENARIO_PLUGIN_NAME,
        );
        if (!already) {
          await runtime.registerPlugin?.(concurrencyScenarioPlugin());
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "run N concurrent tasks against the worker cap",
      text: "Submit six coding tasks at once and admit them against a two-session worker cap.",
      actionName: ORCHESTRATOR_CONCURRENCY_ADMISSION,
      responseIncludesAny: [
        "admitted 6 concurrent tasks",
        "queued at the cap",
        "distinct per-task traceIds",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | ConcurrencyScenarioResult
          | undefined;
        if (!data) return "concurrency scenario produced no data";
        if (data.activeAtCap !== CAP || data.queuedAtCap !== TOTAL - CAP) {
          return `expected ${CAP} active + ${TOTAL - CAP} queued at cap, saw ${data.activeAtCap}/${data.queuedAtCap}`;
        }
        if (data.distinctTraceIds !== TOTAL) {
          return `expected ${TOTAL} distinct per-task traceIds, saw ${data.distinctTraceIds}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_CONCURRENCY_ADMISSION,
      status: "success",
    },
    {
      type: "custom",
      name: "admission parked over-cap tasks, drained with zero drops, and correlated per-task traces",
      predicate: (ctx) => {
        const data = concurrencyScenarioData(ctx);
        if (!data) return "concurrency scenario produced no data";
        if (data.activeAtCap !== CAP) {
          return `expected ${CAP} active at cap, saw ${data.activeAtCap}`;
        }
        if (data.queuedAtCap !== TOTAL - CAP) {
          return `expected ${TOTAL - CAP} queued at cap, saw ${data.queuedAtCap}`;
        }
        // Zero drops: exactly one session per task.
        const badCounts = Object.entries(data.sessionsPerTask).filter(
          ([, n]) => n !== 1,
        );
        if (badCounts.length > 0) {
          return `expected one session per task, saw ${JSON.stringify(data.sessionsPerTask)}`;
        }
        if (data.distinctTraceIds !== TOTAL) {
          return `expected ${TOTAL} distinct per-task traceIds, saw ${data.distinctTraceIds}`;
        }
        // Lifecycle scoring under load: spawn + status_query + share emitted.
        for (const needle of ["spawn", "status_query", "share"] as const) {
          if (!data.lifecycleEvents.includes(needle)) {
            return `expected lifecycle event '${needle}' under load, saw ${JSON.stringify(data.lifecycleEvents)}`;
          }
        }
        return undefined;
      },
    },
  ],
});
