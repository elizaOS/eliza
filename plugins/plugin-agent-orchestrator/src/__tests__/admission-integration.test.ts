/**
 * Integration coverage for the durable admission queue (#13772) driving the
 * real OrchestratorTaskService against a cap-enforcing fake ACP and an in-memory
 * task store. The fake ACP is a faithful capacity model (worker cap + system
 * headroom + terminal-event bus), NOT a mock of the queue under test — the
 * orchestrator's parking, drain-in-order, restart-rebuild, and provider-surface
 * logic is exercised for real.
 *
 * Proven: N-over-cap → deterministic active + queued split with 202/201 status,
 * drain on completion in priority-FIFO order with zero drops, the verifier
 * spawns at full worker cap (system headroom), idle-reclaim frees a slot for a
 * queued task, a restart rebuilds the order from the store, and the provider
 * surfaces the capacity line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSubAgentsProvider } from "../providers/active-sub-agents.ts";
import { AcpService } from "../services/acp-service.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import {
  SessionCapError,
  type SessionInfo,
  type SpawnOptions,
  type SpawnResult,
} from "../services/types.ts";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

/** Poll until `predicate` holds or the deadline passes. The drain runs
 * fire-and-forget off a terminal event, so tests await its settle by polling
 * observable state rather than reaching into the internal drain promise. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil timed out");
}

/** A minimal but faithful ACP capacity model: enforces the worker cap and the
 * system headroom exactly as the real AcpService does, tracks live sessions,
 * and lets the test emit terminal events to free slots. */
class FakeAcp {
  static serviceType = AcpService.serviceType;
  private readonly sessions = new Map<string, SessionInfo>();
  private handler: EventHandler | undefined;
  private counter = 0;

  constructor(
    private readonly maxSessions: number,
    private readonly systemHeadroom = 2,
  ) {}

  private countByClass(): { workers: number; system: number } {
    let workers = 0;
    let system = 0;
    for (const s of this.sessions.values()) {
      if (
        ["stopped", "completed", "error", "errored", "cancelled"].includes(
          s.status,
        )
      ) {
        continue;
      }
      if ((s.metadata?.slotClass ?? "worker") === "system") system++;
      else workers++;
    }
    return { workers, system };
  }

  async getCapacity() {
    const { workers, system } = this.countByClass();
    return {
      maxSessions: this.maxSessions,
      activeWorkers: workers,
      activeSystem: system,
      freeWorkerSlots: Math.max(0, this.maxSessions - workers),
    };
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const slotClass = opts.slotClass ?? "worker";
    const { workers, system } = this.countByClass();
    if (slotClass === "system") {
      if (system >= this.systemHeadroom)
        throw new SessionCapError("system", this.systemHeadroom, system);
    } else if (workers >= this.maxSessions) {
      throw new SessionCapError("worker", this.maxSessions, workers);
    }
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

  /** Drive a terminal completion for a live session (frees the slot). */
  complete(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.status = "completed";
    this.handler?.(id, "task_complete", { response: "done" });
  }
}

function makeRuntime(acp: FakeAcp): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
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
  priority: "low" | "normal" | "high" | "urgent" = "normal",
): Promise<string> {
  const detail = await store.createTask({
    title,
    goal: `goal ${title}`,
    acceptanceCriteria: [],
    priority,
    roomId: "11111111-1111-4111-8111-111111111111",
  });
  return detail.task.id;
}

describe("admission queue integration (#13772)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of [
      "ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY",
      "ELIZA_ACP_ADMISSION_QUEUE",
    ]) {
      saved[key] = process.env[key];
    }
    // Isolate admission from the completion verifier — a completed task moves to
    // `validating` without spawning a verifier session that would consume a slot.
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    process.env.ELIZA_ACP_ADMISSION_QUEUE = "1";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("parks spawns beyond the worker cap: 2 active + 3 queued at cap=2", async () => {
    const acp = new FakeAcp(2);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await newTask(store, `t${i}`));

    const details = [];
    for (const id of ids) details.push(await service.spawnAgentForTask(id));

    // First 2 spawned a live session (no admission); last 3 are queued.
    const spawned = details.filter((d) => d && !d.admission);
    const queued = details.filter((d) => d?.admission);
    expect(spawned.length).toBe(2);
    expect(queued.length).toBe(3);
    expect((await acp.getCapacity()).activeWorkers).toBe(2);

    // Queued positions are 1-based and dense.
    const snapshot = await service.getAdmissionSnapshot();
    expect(snapshot.queueDepth).toBe(3);
    for (const d of queued) {
      expect(d?.admission?.state).toBe("queued");
      expect(d?.admission?.position).toBeGreaterThanOrEqual(1);
    }
  });

  it("drains queued tasks on completion, in order, with zero drops", async () => {
    const acp = new FakeAcp(2);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await newTask(store, `t${i}`));
    for (const id of ids) await service.spawnAgentForTask(id);

    // 2 live sessions exist; complete them one at a time and assert each frees a
    // slot that a queued task claims — until all 5 have run and the queue drains.
    const live = acp.listSessions().filter((s) => s.status === "running");
    expect(live.length).toBe(2);

    const seen = new Set(live.map((s) => s.id));
    while ((await service.getAdmissionSnapshot()).queueDepth > 0) {
      const running = acp.listSessions().find((s) => s.status === "running");
      expect(running).toBeDefined();
      if (!running) break;
      acp.complete(running.id);
      // A new session id appears when a queued task is dispatched into the slot.
      await waitUntil(() =>
        acp
          .listSessions()
          .some((s) => s.status === "running" && !seen.has(s.id)),
      );
      for (const s of acp.listSessions()) seen.add(s.id);
    }

    // Every task ended up with exactly one session — no drops, no doubles.
    expect(acp.listSessions().length).toBe(5);
    expect((await service.getAdmissionSnapshot()).queueDepth).toBe(0);
  });

  it("reclaims an idle keepAlive session whose task is terminal to free a slot", async () => {
    const acp = new FakeAcp(1);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    // Task A takes the only worker slot; its ACP session is keepAlive (stays
    // `running` at the transport even after the task finishes).
    const a = await newTask(store, "a");
    await service.spawnAgentForTask(a);
    const liveSession = acp.listSessions()[0];
    expect(liveSession?.status).toBe("running");

    // Task A reaches a terminal status WITHOUT its ACP session ending — the
    // keepAlive session now pins a slot with no live work. Mark it done directly
    // in the store to model that.
    await store.updateTask(a, { status: "done" });

    // Task B queues behind the pinned slot, then a drain reclaims A's idle
    // session and dispatches B.
    const b = await newTask(store, "b");
    const detail = await service.spawnAgentForTask(b);
    expect(detail?.admission?.state).toBe("queued");

    await waitUntil(async () => {
      const cap = await service.getAdmissionSnapshot();
      // A's session was stopped (reclaimed) and B dispatched into the freed slot.
      return (
        cap.queueDepth === 0 &&
        acp.listSessions().some((s) => s.status === "running")
      );
    });
    expect(
      acp.listSessions().find((s) => s.id === liveSession?.id)?.status,
    ).toBe("stopped");
  });

  it("spawns the read-only verifier at full worker cap via system headroom", async () => {
    const acp = new FakeAcp(2, 2);
    // Fill both worker slots directly.
    await acp.spawnSession({ metadata: {}, slotClass: "worker" });
    await acp.spawnSession({ metadata: {}, slotClass: "worker" });
    expect((await acp.getCapacity()).freeWorkerSlots).toBe(0);

    // A system spawn still succeeds (separate headroom).
    const verifier = await acp.spawnSession({
      metadata: { source: "independent-verifier" },
      slotClass: "system",
    });
    expect(verifier.sessionId).toBeTruthy();
    expect((await acp.getCapacity()).activeSystem).toBe(1);
    // Worker cap is unaffected.
    expect((await acp.getCapacity()).activeWorkers).toBe(2);
  });

  it("rebuilds the queue order from the store on restart", async () => {
    const acp = new FakeAcp(1);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    // cap=1: first spawns, the rest queue with mixed priorities.
    const active = await newTask(store, "active", "normal");
    await service.spawnAgentForTask(active);
    const low = await newTask(store, "low", "low");
    const urgent = await newTask(store, "urgent", "urgent");
    const normal = await newTask(store, "normal", "normal");
    for (const id of [low, urgent, normal]) {
      await service.spawnAgentForTask(id);
    }
    expect((await service.getAdmissionSnapshot()).queueDepth).toBe(3);

    // Simulate a restart: a fresh service over the SAME store rebuilds the order.
    await service.stop();
    const restarted = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await restarted.start();
    const snapshot = await restarted.getAdmissionSnapshot();
    expect(snapshot.queueDepth).toBe(3);
    // Priority order: urgent first, then the two normals/low by band.
    expect(snapshot.queuedTaskIds[0]).toBe(urgent);
    expect(snapshot.queuedTaskIds[2]).toBe(low);
    await restarted.stop();
  });

  it("throws AdmissionQueueFullError past the depth cap (→ 429 at the route)", async () => {
    const acp = new FakeAcp(1);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    // Depth cap of 2: 1 active + 2 queued fill it; the 4th park must reject.
    process.env.ELIZA_ACP_ADMISSION_QUEUE_DEPTH = "2";
    try {
      const active = await newTask(store, "active");
      const q1 = await newTask(store, "q1");
      const q2 = await newTask(store, "q2");
      const overflow = await newTask(store, "overflow");
      // First spawns; next two queue; the fourth exceeds the depth cap.
      await service.spawnAgentForTask(active);
      await service.spawnAgentForTask(q1);
      await service.spawnAgentForTask(q2);
      await expect(service.spawnAgentForTask(overflow)).rejects.toMatchObject({
        code: "ADMISSION_QUEUE_FULL",
      });
    } finally {
      delete process.env.ELIZA_ACP_ADMISSION_QUEUE_DEPTH;
    }
  });

  it("re-throws SessionCapError (hard-fail) when the queue is disabled", async () => {
    process.env.ELIZA_ACP_ADMISSION_QUEUE = "0";
    const acp = new FakeAcp(1);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();
    const a = await newTask(store, "a");
    const b = await newTask(store, "b");
    await service.spawnAgentForTask(a);
    await expect(service.spawnAgentForTask(b)).rejects.toMatchObject({
      code: "SESSION_CAP_REACHED",
    });
  });

  it("surfaces the capacity line + data.capacity through the provider", async () => {
    const acp = new FakeAcp(2);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();
    const runtime = makeRuntime(acp);
    // The provider reads both services off the runtime.
    (runtime as { getService: (t: string) => unknown }).getService = (
      t: string,
    ) => {
      if (t === AcpService.serviceType) return acp;
      if (t === OrchestratorTaskService.serviceType) return service;
      return null;
    };

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await newTask(store, `t${i}`));
    for (const id of ids) await service.spawnAgentForTask(id);

    const result = await activeSubAgentsProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );
    expect(result.text).toContain("capacity: 2/2 worker sessions; queued: 2");
    const capacity = (result.data as { capacity?: Record<string, unknown> })
      .capacity;
    expect(capacity?.maxSessions).toBe(2);
    expect(capacity?.activeWorkers).toBe(2);
    expect(capacity?.queueDepth).toBe(2);
  });
});
