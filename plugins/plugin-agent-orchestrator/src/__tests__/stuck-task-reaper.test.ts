/**
 * Stuck-task lifecycle reconciliation (the 45m+ "stalled" color-pop incident).
 *
 * Integration-style with a deterministic in-process ACP stand-in (the same
 * FakeAcp shape admission-integration.test.ts uses); the
 * OrchestratorTaskService, its store, the transition table, and the supervisor
 * digest functions are all real. Proven here:
 *
 *  - a session that stops WITHOUT task_complete leaves its task `active` with
 *    nothing running; the reaper reconciles it to `interrupted` past the idle
 *    threshold, with an audit event, and the task drops out of the
 *    supervisor's in-flight digest scan;
 *  - fresh stops (under the threshold) and genuinely live sessions are never
 *    reaped;
 *  - a session that VANISHED from the ACP layer with no terminal event counts
 *    as dead: the row is repaired to `stopped` and the task reconciled;
 *  - a teardown `stopped` after `task_complete` no longer stomps the
 *    `completed` session record, and a `validating` task is left to the
 *    verification gate (never reaped);
 *  - `stopTaskAgent` on the task's last live worker interrupts the task
 *    immediately (no lingering `active` shell);
 *  - a fresh spawn on a reaped task re-activates it through the `restarted`
 *    edge (interrupted is recoverable, not a dead end).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import {
  runSupervisorTick,
  type SupervisorTaskView,
} from "../services/task-supervisor-service.ts";
import type {
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../services/types.ts";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

const ROOM = "11111111-1111-4111-8111-111111111111";

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil timed out");
}

/** Minimal deterministic ACP stand-in: tracks sessions, lets the test emit
 * lifecycle events, and can make a session vanish without any event (the
 * swept/lost-across-restart case the reaper must catch). */
class FakeAcp {
  static serviceType = AcpService.serviceType;
  private readonly sessions = new Map<string, SessionInfo>();
  private handler: EventHandler | undefined;
  private counter = 0;

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const id = `sess-${++this.counter}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? "/tmp/work",
      status: "running",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}) },
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

  async getCapacity() {
    const active = [...this.sessions.values()].filter(
      (s) =>
        !["stopped", "completed", "error", "errored", "cancelled"].includes(
          s.status,
        ),
    ).length;
    return {
      maxSessions: 8,
      systemHeadroom: 2,
      activeWorkers: active,
      activeSystem: 0,
      freeWorkerSlots: Math.max(0, 8 - active),
      freeSystemSlots: 2,
    };
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    return this.sessions.get(id) ?? null;
  }

  async stopSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.status = "stopped";
    this.handler?.(id, "stopped", {});
  }

  onSessionEvent(cb: EventHandler): () => void {
    this.handler = cb;
    return () => {
      this.handler = undefined;
    };
  }

  getChangedPaths(): string[] {
    return [];
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }

  /** The session's subprocess/record is simply GONE — no terminal event ever
   * reached the bridge (host restart without persistence, stale sweep). */
  vanish(id: string): void {
    this.sessions.delete(id);
  }
}

function makeRuntime(acp: FakeAcp): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000042",
    character: { name: "Reaper" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: vi.fn(async () => "{}"),
    reportError: vi.fn(),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

async function newTask(
  store: OrchestratorTaskStore,
  title: string,
): Promise<string> {
  const detail = await store.createTask({
    title,
    goal: `goal ${title}`,
    acceptanceCriteria: [],
    priority: "normal",
    roomId: ROOM,
  });
  return detail.task.id;
}

/** Build supervisor views straight from the REAL task service (the same shape
 * runOnce builds), bypassing only the young-task age gate so the scan itself —
 * LIVE_STATUSES membership — is what the assertion exercises. */
async function supervisorPosts(
  service: OrchestratorTaskService,
): Promise<string[]> {
  const tasks = await service.listTasks({ includeArchived: false });
  const views: SupervisorTaskView[] = await Promise.all(
    tasks.map(async (t) => ({
      id: t.id,
      label: t.title,
      status: t.status,
      activeSessions: t.activeSessionCount,
      sessionLabel: t.latestSessionLabel,
      origin: await service.getTaskOriginTarget(t.id),
    })),
  );
  const posted: string[] = [];
  await runSupervisorTick(
    views,
    async (_target, content) => {
      posted.push(String(content.text ?? ""));
    },
    new Map(),
  );
  return posted;
}

const MIN = 60_000;

describe("stuck-task reaper (stalled color-pop incident)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY",
      "ELIZA_ACP_ADMISSION_QUEUE",
      "ELIZA_ORCHESTRATOR_STUCK_TASK_REAPER",
    ]) {
      saved[key] = process.env[key];
    }
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    process.env.ELIZA_ACP_ADMISSION_QUEUE = "1";
    // The interval timer is exercised implicitly by start(); ticks are driven
    // explicitly through reapStuckTasks(nowMs) for determinism.
    process.env.ELIZA_ORCHESTRATOR_STUCK_TASK_REAPER = "0";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function harness() {
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();
    return { acp, store, service };
  }

  it("reconciles an active task whose only session stopped without task_complete, dropping it from the supervisor scan", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "color-pop app-build");
    await service.spawnAgentForTask(taskId);
    const session = acp.listSessions()[0];
    acp.emit(session.id, "ready", { sessionId: session.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });

    // The incident: the session tears down with a bare `stopped` — no
    // task_complete ever reaches the bridge. The task is left `active`.
    await acp.stopSession(session.id);
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return doc?.sessions[0]?.status === "stopped";
    });
    expect((await store.getTask(taskId))?.task.status).toBe("active");
    // Pre-reap, the supervisor's in-flight scan still surfaces it.
    expect((await supervisorPosts(service)).join("\n")).toContain(
      "color-pop app-build",
    );

    // Under the idle threshold nothing is reaped.
    expect(await service.reapStuckTasks(Date.now() + MIN)).toEqual([]);
    expect((await store.getTask(taskId))?.task.status).toBe("active");

    // Past the threshold the task reconciles to `interrupted` with an audit
    // event, and the supervisor scan no longer surfaces it.
    const reaped = await service.reapStuckTasks(Date.now() + 6 * MIN);
    expect(reaped).toEqual([taskId]);
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("interrupted");
    expect(doc?.events.some((e) => e.eventType === "task_stalled_reaped")).toBe(
      true,
    );
    expect(await supervisorPosts(service)).toEqual([]);

    await service.stop();
  });

  it("never reaps a task with a genuinely live session, regardless of idle time", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "long-running build");
    await service.spawnAgentForTask(taskId);
    const session = acp.listSessions()[0];
    acp.emit(session.id, "ready", { sessionId: session.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });

    expect(await service.reapStuckTasks(Date.now() + 60 * MIN)).toEqual([]);
    expect((await store.getTask(taskId))?.task.status).toBe("active");

    await service.stop();
  });

  it("treats a session that vanished from the ACP layer with no event as dead: repairs the row and reconciles the task", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "vanished worker");
    await service.spawnAgentForTask(taskId);
    const session = acp.listSessions()[0];
    acp.emit(session.id, "ready", { sessionId: session.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });

    // The subprocess/record is gone; the bridge never saw a terminal event, so
    // the durable row still LOOKS live.
    acp.vanish(session.id);
    expect((await store.getTask(taskId))?.sessions[0]?.status).not.toBe(
      "stopped",
    );

    const reaped = await service.reapStuckTasks(Date.now() + 6 * MIN);
    expect(reaped).toEqual([taskId]);
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("interrupted");
    expect(doc?.sessions[0]?.status).toBe("stopped");

    await service.stop();
  });

  it("leaves a validating task to the verification gate: teardown `stopped` never stomps `completed`, and the reaper skips it", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "completed then torn down");
    await service.spawnAgentForTask(taskId);
    const session = acp.listSessions()[0];
    acp.emit(session.id, "ready", { sessionId: session.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });

    acp.emit(session.id, "task_complete", { response: "done, shipped" });
    await waitUntil(
      async () => (await store.getTask(taskId))?.task.status === "validating",
    );
    expect((await store.getTask(taskId))?.sessions[0]?.status).toBe(
      "completed",
    );

    // KeepAlive teardown after completion: `stopped` must not rewrite the
    // completed record (the completion pipeline keys off it).
    acp.emit(session.id, "stopped", {});
    await new Promise((r) => setTimeout(r, 25));
    expect((await store.getTask(taskId))?.sessions[0]?.status).toBe(
      "completed",
    );

    // And a validating task is the verifier's to settle — never the reaper's.
    expect(await service.reapStuckTasks(Date.now() + 60 * MIN)).toEqual([]);
    expect((await store.getTask(taskId))?.task.status).toBe("validating");

    await service.stop();
  });

  it("stopTaskAgent on the last live worker interrupts the task immediately", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "operator-stopped build");
    await service.spawnAgentForTask(taskId);
    const session = acp.listSessions()[0];
    acp.emit(session.id, "ready", { sessionId: session.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });

    await expect(service.stopTaskAgent(taskId, session.id)).resolves.toBe(true);
    await waitUntil(
      async () => (await store.getTask(taskId))?.task.status === "interrupted",
    );
    expect(await supervisorPosts(service)).toEqual([]);

    await service.stop();
  });

  it("a fresh spawn re-activates a reaped task through the restarted edge", async () => {
    const { acp, store, service } = await harness();
    const taskId = await newTask(store, "reaped then respawned");
    await service.spawnAgentForTask(taskId);
    const first = acp.listSessions()[0];
    acp.emit(first.id, "ready", { sessionId: first.id });
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return (
        doc?.task.status === "active" && doc.sessions[0]?.status === "ready"
      );
    });
    await acp.stopSession(first.id);
    await waitUntil(async () => {
      const doc = await store.getTask(taskId);
      return doc?.sessions[0]?.status === "stopped";
    });
    expect(await service.reapStuckTasks(Date.now() + 6 * MIN)).toEqual([
      taskId,
    ]);
    expect((await store.getTask(taskId))?.task.status).toBe("interrupted");

    // A late zombie event alone must NOT resurrect the task…
    acp.emit(first.id, "ready", { sessionId: first.id });
    await new Promise((r) => setTimeout(r, 25));
    expect((await store.getTask(taskId))?.task.status).toBe("interrupted");

    // …but a real new spawn re-engages it (interrupted → restarted → active).
    await service.spawnAgentForTask(taskId);
    await waitUntil(
      async () => (await store.getTask(taskId))?.task.status === "active",
    );

    await service.stop();
  });
});
