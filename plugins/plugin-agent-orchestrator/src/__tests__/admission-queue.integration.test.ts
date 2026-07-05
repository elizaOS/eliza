/**
 * Real-service integration coverage for the orchestrator admission queue
 * (#13772). Drives the REAL OrchestratorTaskService + REAL in-memory task store
 * against a faithful fake ACP transport that enforces the same slot-class cap +
 * throws the real SessionCapError. Proves: park-at-cap (202 + position),
 * priority-ordered drain with zero drops as sessions complete, depth-cap
 * rejection, dequeue on pause/archive, rebuild-from-store ordering on restart,
 * the capacity snapshot, the ACTIVE_SUB_AGENTS provider capacity line, and the
 * reject-at-cap kill switch.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSubAgentsProvider } from "../providers/active-sub-agents.js";
import { type AcpCapacity, AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { OrchestratorTaskPriority } from "../services/orchestrator-task-types.js";
import {
  AdmissionQueueFullError,
  SessionCapError,
  type SessionInfo,
  type SpawnOptions,
  type SpawnResult,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

/**
 * Faithful fake ACP transport: mirrors AcpService's slot-class cap accounting
 * and throws the REAL SessionCapError so the service's admission path exercises
 * the true error type. `spawnLog` records dispatch order for assertions.
 */
class FakeAcp {
  readonly spawnLog: string[] = [];
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly handlers = new Set<EventHandler>();
  private counter = 0;
  private clock = 0;

  constructor(
    private readonly maxSessions: number,
    private readonly systemHeadroom = 2,
  ) {}

  onSessionEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private countActive(): { workers: number; system: number } {
    let workers = 0;
    let system = 0;
    for (const session of this.sessions.values()) {
      if (TERMINAL_SESSION_STATUSES.has(session.status)) continue;
      if (
        (session.metadata as Record<string, unknown> | undefined)?.slotClass ===
        "system"
      ) {
        system += 1;
      } else {
        workers += 1;
      }
    }
    return { workers, system };
  }

  async getCapacity(): Promise<AcpCapacity> {
    const { workers, system } = this.countActive();
    return {
      maxSessions: this.maxSessions,
      activeWorkers: workers,
      activeSystem: system,
      systemHeadroom: this.systemHeadroom,
      freeSlots: Math.max(0, this.maxSessions - workers),
    };
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const slotClass = opts.slotClass === "system" ? "system" : "worker";
    const { workers, system } = this.countActive();
    if (slotClass === "system") {
      if (system >= this.systemHeadroom) {
        throw new SessionCapError({
          maxSessions: this.systemHeadroom,
          activeCount: system,
          slotClass: "system",
        });
      }
    } else if (workers >= this.maxSessions) {
      throw new SessionCapError({
        maxSessions: this.maxSessions,
        activeCount: workers,
        slotClass: "worker",
      });
    }
    const id = `sess-${++this.counter}`;
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? "/tmp/orch-x",
      status: "ready",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: new Date(++this.clock),
      lastActivityAt: new Date(this.clock),
      metadata: { ...(opts.metadata ?? {}), slotClass },
    };
    this.sessions.set(id, session);
    const taskId = (opts.metadata as Record<string, unknown> | undefined)
      ?.taskId;
    if (typeof taskId === "string") this.spawnLog.push(taskId);
    return {
      sessionId: id,
      id,
      name: session.name ?? id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: "ready",
      metadata: session.metadata,
    };
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    return this.sessions.get(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()];
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = "stopped";
    this.emit(sessionId, "stopped", {});
  }

  /** Test helper: drive the active session of a task to completion (frees its
   *  worker slot and fires the terminal event that triggers a drain). */
  completeByTask(taskId: string): void {
    for (const session of this.sessions.values()) {
      if (TERMINAL_SESSION_STATUSES.has(session.status)) continue;
      if (
        (session.metadata as Record<string, unknown> | undefined)?.taskId ===
        taskId
      ) {
        session.status = "completed";
        this.emit(session.id, "task_complete", { response: "done" });
        return;
      }
    }
    throw new Error(`no active session for task ${taskId}`);
  }

  /** Test helper: seed a pre-existing active worker (a full cap before start). */
  seedActiveWorker(taskId: string): void {
    const id = `seed-${++this.counter}`;
    this.sessions.set(id, {
      id,
      name: id,
      agentType: "opencode",
      workdir: "/tmp/orch-x",
      status: "ready",
      approvalPreset: "standard",
      createdAt: new Date(++this.clock),
      lastActivityAt: new Date(this.clock),
      metadata: { taskId, slotClass: "worker", keepAliveAfterComplete: true },
    });
  }

  /** Test helper: seed a completed keepAlive session for a terminal task, so
   *  the dispatcher can reclaim its slot. */
  seedIdleKeepAlive(taskId: string): string {
    const id = `idle-${++this.counter}`;
    this.sessions.set(id, {
      id,
      name: id,
      agentType: "opencode",
      workdir: "/tmp/orch-x",
      status: "ready",
      approvalPreset: "standard",
      createdAt: new Date(++this.clock),
      lastActivityAt: new Date(this.clock),
      metadata: { taskId, slotClass: "worker", keepAliveAfterComplete: true },
    });
    return id;
  }

  private emit(sessionId: string, event: string, data: unknown): void {
    for (const handler of [...this.handlers]) handler(sessionId, event, data);
  }
}

function makeRuntime(
  fake: FakeAcp,
  settings: Record<string, string> = {},
): {
  runtime: IAgentRuntime;
  bindService: (service: OrchestratorTaskService) => void;
} {
  let orchestrator: OrchestratorTaskService | undefined;
  const runtime = {
    character: { name: "Tester" },
    adapter: undefined,
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportError: vi.fn(),
    getSetting: (key: string) => settings[key],
    useModel: vi.fn(async () => "{}"),
    getService: (type: string) => {
      if (
        type === AcpService.serviceType ||
        type === "ACP_SUBPROCESS_SERVICE"
      ) {
        return fake;
      }
      if (type === OrchestratorTaskService.serviceType) return orchestrator;
      return undefined;
    },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    bindService: (service) => {
      orchestrator = service;
    },
  };
}

async function makeService(
  fake: FakeAcp,
  settings: Record<string, string> = {},
): Promise<{ service: OrchestratorTaskService; runtime: IAgentRuntime }> {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const { runtime, bindService } = makeRuntime(fake, settings);
  const service = new OrchestratorTaskService(runtime as never, { store });
  bindService(service);
  await service.start();
  return { service, runtime };
}

async function seedTask(
  service: OrchestratorTaskService,
  input: {
    title?: string;
    priority?: OrchestratorTaskPriority;
    roomId?: string;
  } = {},
): Promise<string> {
  const store = (service as unknown as { store: OrchestratorTaskStore }).store;
  const doc = await store.createTask({
    title: input.title ?? "task",
    goal: "do the thing",
    acceptanceCriteria: [],
    priority: input.priority,
    roomId: input.roomId,
  });
  return doc.task.id;
}

describe("orchestrator admission queue (real service + fake ACP)", () => {
  let savedVerifyFlag: string | undefined;
  beforeEach(() => {
    savedVerifyFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  });
  afterEach(() => {
    if (savedVerifyFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedVerifyFlag;
    vi.restoreAllMocks();
  });

  it("parks tasks at the session cap, returning a queued DTO with a position", async () => {
    const fake = new FakeAcp(2);
    const { service } = await makeService(fake);

    // Two spawns fill the worker pool.
    const a = await seedTask(service, { title: "A" });
    const b = await seedTask(service, { title: "B" });
    const detailA = await service.spawnAgentForTask(a);
    const detailB = await service.spawnAgentForTask(b);
    expect(detailA?.admission).toBeUndefined();
    expect(detailB?.admission).toBeUndefined();
    expect(detailA?.status).toBe("active");

    // Enqueue three more, in REVERSE priority order, to prove the queue reorders
    // by priority (not insertion): low, then high, then urgent.
    const low = await seedTask(service, { title: "low", priority: "low" });
    const high = await seedTask(service, { title: "high", priority: "high" });
    const urgent = await seedTask(service, {
      title: "urgent",
      priority: "urgent",
    });
    const detailLow = await service.spawnAgentForTask(low);
    const detailHigh = await service.spawnAgentForTask(high);
    const detailUrgent = await service.spawnAgentForTask(urgent);

    expect(detailLow?.admission?.state).toBe("queued");
    expect(detailHigh?.admission?.state).toBe("queued");
    expect(detailUrgent?.admission?.state).toBe("queued");
    // Urgent, enqueued last, still lands at the head.
    expect(detailUrgent?.admission?.position).toBe(1);

    // The two spawned tasks stayed active; three are parked.
    const capacity = await service.getCapacitySnapshot();
    expect(capacity).toMatchObject({
      maxSessions: 2,
      activeWorkers: 2,
      freeSlots: 0,
      queueDepth: 3,
    });
    expect(capacity.queue.map((q) => q.taskId)).toEqual([urgent, high, low]);
    expect(capacity.queue.map((q) => q.position)).toEqual([1, 2, 3]);

    await service.stop();
  });

  it("drains in priority order with zero drops as sessions complete", async () => {
    const fake = new FakeAcp(2);
    const { service } = await makeService(fake);

    const fillerA = await seedTask(service, { title: "fillA" });
    const fillerB = await seedTask(service, { title: "fillB" });
    await service.spawnAgentForTask(fillerA);
    await service.spawnAgentForTask(fillerB);

    const low = await seedTask(service, { title: "low", priority: "low" });
    const high = await seedTask(service, { title: "high", priority: "high" });
    const urgent = await seedTask(service, {
      title: "urgent",
      priority: "urgent",
    });
    await service.spawnAgentForTask(low);
    await service.spawnAgentForTask(high);
    await service.spawnAgentForTask(urgent);
    expect(fake.spawnLog).toEqual([fillerA, fillerB]);

    // Free a slot: the highest-priority queued task (urgent) dispatches.
    fake.completeByTask(fillerA);
    await vi.waitFor(() => expect(fake.spawnLog).toContain(urgent));

    fake.completeByTask(fillerB);
    await vi.waitFor(() => expect(fake.spawnLog).toContain(high));

    fake.completeByTask(urgent);
    await vi.waitFor(() => expect(fake.spawnLog).toContain(low));

    // Dispatch order after the two fillers is exactly the priority order — and
    // every queued task was dispatched (zero drops).
    expect(fake.spawnLog.slice(2)).toEqual([urgent, high, low]);
    const finalCapacity = await service.getCapacitySnapshot();
    expect(finalCapacity.queueDepth).toBe(0);

    await service.stop();
  });

  it("rejects a spawn beyond the queue depth cap with AdmissionQueueFullError", async () => {
    const fake = new FakeAcp(1);
    const { service } = await makeService(fake, {
      ELIZA_ACP_ADMISSION_QUEUE_DEPTH: "2",
    });

    const active = await seedTask(service, { title: "active" });
    await service.spawnAgentForTask(active); // fills the 1 worker slot

    const q1 = await seedTask(service, { title: "q1" });
    const q2 = await seedTask(service, { title: "q2" });
    const q3 = await seedTask(service, { title: "q3" });
    await service.spawnAgentForTask(q1); // depth 1
    await service.spawnAgentForTask(q2); // depth 2 (cap)

    await expect(service.spawnAgentForTask(q3)).rejects.toBeInstanceOf(
      AdmissionQueueFullError,
    );
    expect((await service.getCapacitySnapshot()).queueDepth).toBe(2);

    await service.stop();
  });

  it("dequeues a queued task on pause and re-enqueues on resume", async () => {
    const fake = new FakeAcp(1);
    const { service } = await makeService(fake);

    const active = await seedTask(service, { title: "active" });
    await service.spawnAgentForTask(active);
    const queued = await seedTask(service, { title: "queued" });
    const detail = await service.spawnAgentForTask(queued);
    expect(detail?.admission?.state).toBe("queued");

    // Pause removes it from the dispatch running.
    await service.pauseTask(queued);
    expect((await service.getCapacitySnapshot()).queueDepth).toBe(0);

    // Freeing a slot does NOT dispatch the paused task.
    fake.completeByTask(active);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.spawnLog).not.toContain(queued);

    // Resume re-enqueues and, with a slot now free, dispatches it.
    await service.resumeTask(queued);
    await vi.waitFor(() => expect(fake.spawnLog).toContain(queued));

    await service.stop();
  });

  it("clears the admission entry when a queued task is archived", async () => {
    const fake = new FakeAcp(1);
    const { service } = await makeService(fake);

    const active = await seedTask(service, { title: "active" });
    await service.spawnAgentForTask(active);
    const queued = await seedTask(service, { title: "queued" });
    await service.spawnAgentForTask(queued);
    expect((await service.getCapacitySnapshot()).queueDepth).toBe(1);

    await service.archiveTask(queued);
    expect((await service.getCapacitySnapshot()).queueDepth).toBe(0);
    const detail = await service.getTask(queued);
    expect(detail?.status).toBe("archived");
    expect(detail?.admission).toBeUndefined();
    expect(detail?.metadata.admission).toBeUndefined();

    // A freed slot never resurrects the archived task.
    fake.completeByTask(active);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.spawnLog).not.toContain(queued);

    await service.stop();
  });

  it("reconstructs the queue order from durable state on restart", async () => {
    // Pre-seed a store with a full worker pool + two parked tasks, then start a
    // fresh service against it: the queue must rebuild in enqueue order.
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const first = await store.createTask({
      title: "first",
      goal: "g",
      acceptanceCriteria: [],
      metadata: {
        admission: {
          state: "queued",
          enqueuedAt: 1000,
          priorityAtEnqueue: "normal",
          spawnOpts: {},
        },
      },
    });
    const second = await store.createTask({
      title: "second",
      goal: "g",
      acceptanceCriteria: [],
      metadata: {
        admission: {
          state: "queued",
          enqueuedAt: 2000,
          priorityAtEnqueue: "normal",
          spawnOpts: {},
        },
      },
    });

    const fake = new FakeAcp(1);
    fake.seedActiveWorker("occupant"); // cap full → parked tasks stay queued
    const { runtime, bindService } = makeRuntime(fake);
    const service = new OrchestratorTaskService(runtime as never, { store });
    bindService(service);
    await service.start();

    const snapshot = await service.getCapacitySnapshot();
    expect(snapshot.queueDepth).toBe(2);
    expect(snapshot.queue.map((q) => q.taskId)).toEqual([
      first.task.id,
      second.task.id,
    ]);

    await service.stop();
  });

  it("reclaims an idle keepAlive slot for a queued task when no worker slot is free", async () => {
    const fake = new FakeAcp(1);
    const { service } = await makeService(fake);

    // A done task whose keepAlive session is still alive holds the only worker
    // slot; a new task queues behind it.
    const doneTask = await seedTask(service, { title: "done" });
    const idleSessionId = fake.seedIdleKeepAlive(doneTask);
    // Mark the holder task terminal so its slot is reclaimable.
    await (
      service as unknown as { store: OrchestratorTaskStore }
    ).store.updateTask(doneTask, { status: "done" });

    const queued = await seedTask(service, { title: "queued" });
    const detail = await service.spawnAgentForTask(queued);
    expect(detail?.admission?.state).toBe("queued");

    // The reconcile drain reclaims the idle slot and dispatches the queued task.
    await (
      service as unknown as { drainAdmissionQueue: () => Promise<void> }
    ).drainAdmissionQueue();
    await vi.waitFor(() => expect(fake.spawnLog).toContain(queued));
    expect((await fake.getSession(idleSessionId))?.status).toBe("stopped");

    await service.stop();
  });

  it("surfaces the capacity line + queued backlog through the ACTIVE_SUB_AGENTS provider", async () => {
    const fake = new FakeAcp(1);
    const { service, runtime } = await makeService(fake);

    const active = await seedTask(service, {
      title: "active",
      roomId: "00000000-0000-4000-8000-0000000000aa",
    });
    await service.spawnAgentForTask(active);
    const queued = await seedTask(service, { title: "queued-work" });
    await service.spawnAgentForTask(queued);

    const result = await activeSubAgentsProvider.get(
      runtime,
      { id: "m" } as never,
      {} as never,
    );
    expect(result.text).toContain("capacity: 1/1 worker sessions; queued: 1");
    const capacity = (result.data as { capacity?: { queueDepth: number } })
      .capacity;
    expect(capacity?.queueDepth).toBe(1);

    await service.stop();
  });

  it("restores reject-at-cap when the admission queue is disabled", async () => {
    const fake = new FakeAcp(1);
    const { service } = await makeService(fake, {
      ELIZA_ACP_ADMISSION_QUEUE: "0",
    });

    const active = await seedTask(service, { title: "active" });
    await service.spawnAgentForTask(active);
    const rejected = await seedTask(service, { title: "rejected" });

    await expect(service.spawnAgentForTask(rejected)).rejects.toMatchObject({
      code: "SESSION_CAP_REACHED",
    });
    expect((await service.getCapacitySnapshot()).queueDepth).toBe(0);

    await service.stop();
  });
});
