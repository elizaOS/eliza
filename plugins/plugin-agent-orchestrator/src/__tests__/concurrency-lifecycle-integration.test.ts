/**
 * Real-engine concurrency lifecycle integration test (#13778, epic #13766
 * WS8) — "integration", not "e2e": the ACP subprocess is a deterministic
 * in-process stand-in, while everything else is real. 10 tasks
 * submitted against a maxSessions=5 worker cap through the REAL
 * OrchestratorTaskService + real TaskWatchdogService, driven by a cap-enforcing
 * deterministic ACP that manages REAL per-session scratch directories the same
 * way AcpService does (mkdir at spawn, rm at every terminal event via the
 * ownership gate). Nothing about the orchestrator's admission queue, terminal
 * transition table, watchdog detection, or scratch teardown is mocked — the fake
 * ACP is a faithful capacity + scratch model standing in only for the
 * subprocess, exactly as admission-integration.test.ts's FakeAcp does for the
 * admission slice. This test extends that slice to the full task lifecycle.
 *
 * Proven end to end:
 *   - deterministic admission: 5 active + 5 queued at cap=5, dense 1-based
 *     positions, priority-band order preserved on drain;
 *   - zero drops: every one of the 10 tasks eventually holds exactly one session;
 *   - watchdog fires on a wedged (idle) session: the real TaskWatchdogService
 *     detects the stall and prods it once;
 *   - legal terminal states: each task reaches done/failed/interrupted only via
 *     an edge in TASK_STATUS_TRANSITIONS (completion → validating → done,
 *     unrecoverable session error → failed), asserted against the table itself;
 *   - zero leaked scratch dirs after the run — an fs-level assertion that doubles
 *     as the #13773 workspace-GC regression guard.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService, computeSessionWorkdir } from "../services/acp-service.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import {
  type OrchestratorTaskStatus,
  TASK_STATUS_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
} from "../services/orchestrator-task-types.ts";
import {
  detectStalledSessions,
  STALL_GRILL_PROMPT,
  TaskWatchdogService,
} from "../services/task-watchdog-service.ts";
import {
  SessionCapError,
  type SessionInfo,
  type SpawnOptions,
  type SpawnResult,
} from "../services/types.ts";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

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

/**
 * A cap-enforcing, scratch-managing deterministic ACP. It enforces the exact
 * worker/system slot accounting AcpService enforces, tracks live sessions, and —
 * unlike the admission slice's in-memory-only fake — mkdir's a REAL per-session
 * scratch dir under a shared workspace root at spawn and rm's it on every
 * terminal event through the same ownership gate AcpService uses
 * (`sessionOwnsIsolatedWorkdir`: isolatedWorkdir metadata + a computed
 * `task-<id>` path under the workdirRoot). That makes the post-run "zero leaked
 * scratch dirs" assertion a genuine fs regression guard for #13773.
 */
class ScratchCapAcp {
  static serviceType = AcpService.serviceType;
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly handlers = new Set<EventHandler>();
  private counter = 0;

  constructor(
    private readonly maxSessions: number,
    private readonly workspaceRoot: string,
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
      systemHeadroom: this.systemHeadroom,
      activeWorkers: workers,
      activeSystem: system,
      freeWorkerSlots: Math.max(0, this.maxSessions - workers),
      freeSystemSlots: Math.max(0, this.systemHeadroom - system),
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
    // Real isolated scratch dir, computed exactly as AcpService does, and
    // recorded in metadata so the ownership gate reclaims it on teardown.
    const workdir = computeSessionWorkdir(this.workspaceRoot, id, true);
    await mkdir(workdir, { recursive: true });
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir,
      status: "running",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: {
        ...(opts.metadata ?? {}),
        slotClass,
        isolatedWorkdir: true,
        workdirRoot: resolve(this.workspaceRoot),
      },
    };
    this.sessions.set(id, session);
    // The task service subscribes for ready→session_active; emit it on a
    // macrotask so the caller's spawnAgentForTask has returned first, matching
    // the real transport's post-resolve event ordering.
    setTimeout(() => this.emit(id, "ready", { sessionId: id }), 0);
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

  async sendToSession(id: string, _text: string) {
    const s = this.sessions.get(id);
    if (s) s.lastActivityAt = new Date();
    return {
      sessionId: id,
      finalText: "ack",
      response: "ack",
      stopReason: "end_turn",
      durationMs: 1,
    };
  }

  getChangedPaths(): string[] {
    return [];
  }

  async stopSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = "stopped";
    await this.reclaim(s);
    this.emit(id, "stopped", { sessionId: id });
  }

  onSessionEvent(cb: EventHandler): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    for (const h of [...this.handlers]) h(sessionId, event, data);
  }

  /** Terminal-completion: the sub-agent reported done. Frees the worker slot
   * (countByClass stops counting a `completed` session) but does NOT reclaim the
   * scratch dir — matching production, where the keepAlive workdir survives
   * task_complete so the completion-evidence trajectory writes into it; reclaim
   * happens on session close. Emits task_complete so the real service moves the
   * task through completion_reported → validating. */
  async complete(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = "completed";
    this.emit(id, "task_complete", { response: "done" });
  }

  /** Terminal-error: an un-respawnable crash. Frees the slot (no reclaim yet;
   * same close-time reclaim rule as complete), then emits an `error` event with
   * no failureKind so the real service classifies it unrecoverable → failed. */
  async fail(id: string, message = "sub-agent crashed"): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = "error";
    this.emit(id, "error", { message });
  }

  /** Mirror AcpService.removeOwnedScratchWorkdir's ownership gate: only reclaim
   * a metadata-owned isolated scratch dir whose path is the computed
   * `task-<id>` under its recorded root. */
  private async reclaim(session: SessionInfo): Promise<void> {
    const md = session.metadata ?? {};
    if (md.isolatedWorkdir !== true) return;
    const root = typeof md.workdirRoot === "string" ? md.workdirRoot : null;
    if (!root) return;
    const expected = computeSessionWorkdir(root, session.id, true);
    if (resolve(session.workdir) !== resolve(expected)) return;
    await rm(session.workdir, { recursive: true, force: true });
  }
}

function makeRuntime(
  acp: ScratchCapAcp,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000013",
    character: { name: "Concurrency" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: (key: string) =>
      (extras.settings as Record<string, string> | undefined)?.[key],
    useModel: vi.fn(async () => "{}"),
    reportError: vi.fn(),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
    ...extras,
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

/** Terminal statuses actually reachable via an edge in the transition table —
 * derived from the table itself so the assertion can never degenerate into
 * comparing a constant against itself. */
const REACHABLE_TERMINAL_STATUSES: ReadonlySet<OrchestratorTaskStatus> =
  new Set(
    Object.values(TASK_STATUS_TRANSITIONS)
      .flatMap((edges) => Object.values(edges))
      .filter((status) => TERMINAL_TASK_STATUSES.has(status)),
  );

/** Assert a status is terminal AND that at least one real transition-table edge
 * produces it — a status the table cannot reach fails here even if someone adds
 * it to TERMINAL_TASK_STATUSES. */
function assertLegalTerminal(status: OrchestratorTaskStatus): void {
  expect(TERMINAL_TASK_STATUSES.has(status)).toBe(true);
  expect(
    REACHABLE_TERMINAL_STATUSES.has(status),
    `terminal status '${status}' is not produced by any TASK_STATUS_TRANSITIONS edge`,
  ).toBe(true);
}

const CAP = 5;
const TOTAL = 10;

describe("real-engine concurrency lifecycle integration (#13778)", () => {
  const saved: Record<string, string | undefined> = {};
  const roots: string[] = [];

  beforeEach(() => {
    for (const key of [
      "ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY",
      "ELIZA_ACP_ADMISSION_QUEUE",
      "ELIZA_ORCHESTRATOR_WATCHDOG",
    ]) {
      saved[key] = process.env[key];
    }
    // Isolate admission from the completion verifier: a completed task moves to
    // `validating` without spawning a verifier session that would consume a slot
    // — we drive validation → done explicitly through the transition table.
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    process.env.ELIZA_ACP_ADMISSION_QUEUE = "1";
    // The watchdog is exercised directly via runOnce()/detectStalledSessions in
    // this test, not on its 60s timer; disable the timer so it never fires
    // asynchronously mid-assertion.
    process.env.ELIZA_ORCHESTRATOR_WATCHDOG = "0";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits 10 tasks against cap=5 deterministically, drains with zero drops, watchdog fires on a wedged session, all reach a legal terminal state, and leaks zero scratch dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-concurrency-e2e-"));
    roots.push(root);
    const acp = new ScratchCapAcp(CAP, root);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    // ── Submit 10 tasks and spawn an agent for each, in a fixed order. ──────
    const ids: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      ids.push(await newTask(store, `t${String(i).padStart(2, "0")}`));
    }
    const details = [];
    for (const id of ids) details.push(await service.spawnAgentForTask(id));

    // ── Deterministic admission: first CAP spawn live, remainder queue. ─────
    const spawned = details.filter((d) => d && !d.admission);
    const queued = details.filter((d) => d?.admission);
    expect(spawned.length).toBe(CAP);
    expect(queued.length).toBe(TOTAL - CAP);
    expect((await acp.getCapacity()).activeWorkers).toBe(CAP);

    const snapshot = await service.getAdmissionSnapshot();
    expect(snapshot.queueDepth).toBe(TOTAL - CAP);
    // Exactly the tasks that met the cap are queued — the last CAP submitted
    // never got a live slot, so the queued SET is precisely ids[CAP..TOTAL].
    // (Order within the single normal-priority band is the queue's deterministic
    // total order — enqueue time then taskId tiebreak — not submit order, so we
    // assert the set, and determinism separately below.)
    expect([...snapshot.queuedTaskIds].sort()).toEqual(
      [...ids.slice(CAP)].sort(),
    );
    // Determinism: re-reading the snapshot yields the identical order (the
    // ordering is a stable total order, not affected by read).
    const reread = await service.getAdmissionSnapshot();
    expect(reread.queuedTaskIds).toEqual(snapshot.queuedTaskIds);
    for (const d of queued) {
      expect(d?.admission?.state).toBe("queued");
      // Each queued spawn reported a real 1-based dispatch position at enqueue.
      expect(d?.admission?.position).toBeGreaterThanOrEqual(1);
      expect(d?.admission?.position).toBeLessThanOrEqual(TOTAL - CAP);
    }
    // Positions over the settled queue are dense + 1-based (each task's live
    // position read back from the current dispatch order covers exactly 1..N).
    const livePositions = await Promise.all(
      snapshot.queuedTaskIds.map(async (id) => {
        const doc = await service.getTask(id);
        return doc?.admission?.position;
      }),
    );
    expect([...livePositions].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5,
    ]);

    // ── Watchdog fires on a wedged session. ─────────────────────────────────
    // Age one live session past the stall threshold, leave the rest fresh, and
    // drive the REAL watchdog once: it must detect exactly that session and
    // prod it (a real acp.sendToSession call), and never prod a fresh one.
    const watchdog = new TaskWatchdogService(
      makeRuntime(acp, {
        settings: { ELIZA_ORCHESTRATOR_STALL_MS: "60000" },
      }) as never,
    );
    const live = acp.listSessions().filter((s) => s.status === "running");
    expect(live.length).toBe(CAP);
    const wedged = live[0];
    const fresh = live[1];
    // 10 minutes idle vs the 60s threshold → wedged is stalled, fresh is not.
    wedged.lastActivityAt = new Date(Date.now() - 10 * 60_000);

    // Pure detector agrees on the boundary before we drive the service.
    const detected = detectStalledSessions(
      acp.listSessions().map((s) => ({
        id: s.id,
        status: s.status,
        lastActivityMs: s.lastActivityAt.getTime(),
      })),
      Date.now(),
      60_000,
    );
    expect(detected.map((d) => d.id)).toEqual([wedged.id]);

    const sendSpy = vi.spyOn(acp, "sendToSession");
    const stalled = await watchdog.runOnce();
    expect(stalled.map((s) => s.id)).toEqual([wedged.id]);
    expect(watchdog.getStalledSessionIds()).toContain(wedged.id);
    expect(sendSpy).toHaveBeenCalledWith(wedged.id, STALL_GRILL_PROMPT);
    expect(sendSpy).not.toHaveBeenCalledWith(fresh.id, STALL_GRILL_PROMPT);
    // A second tick does not re-prod the same still-stalled session (grill once).
    sendSpy.mockClear();
    await watchdog.runOnce();
    expect(sendSpy).not.toHaveBeenCalledWith(wedged.id, STALL_GRILL_PROMPT);

    // ── Drive every task to a terminal state, draining the queue in order. ──
    // First 8 tasks complete successfully (→ validating → done); the last 2 to
    // run crash unrecoverably (→ failed). Each terminal event frees a worker
    // slot, so the admission queue drains until all 10 have held a session.
    let completedCount = 0;
    const failTargetGoals = new Set([`goal t08`, `goal t09`]);

    // Guard against an infinite loop if the drain wedges.
    for (let guard = 0; guard < TOTAL * 4; guard++) {
      // Pick a running session whose spawn `ready` event has already been
      // processed (its task is `active`). Completing before `ready` lands would
      // let the late `session_active` race the `task_complete` advance and leave
      // the task in `active` instead of `validating`; waiting for `active` first
      // makes each task's terminal transition deterministic.
      const running = acp.listSessions().find((s) => s.status === "running");
      if (!running) break;
      const runningTaskId =
        (running.metadata?.taskId as string | undefined) ?? "";
      await waitUntil(async () => {
        const doc = await store.getTask(runningTaskId);
        return doc?.task.status === "active";
      });

      const goal = (running.metadata?.goal as string | undefined) ?? "";
      if (failTargetGoals.has(goal)) {
        await acp.fail(running.id);
        // The unrecoverable-error advance runs on the async event bridge; wait
        // for the task to actually reach terminal `failed` before proceeding.
        await waitUntil(async () => {
          const doc = await store.getTask(runningTaskId);
          return doc?.task.status === "failed";
        });
      } else {
        await acp.complete(running.id);
        completedCount++;
        // Wait for `task_complete` to advance the task to `validating` so the
        // next iteration never observes a half-applied transition.
        await waitUntil(async () => {
          const doc = await store.getTask(runningTaskId);
          return doc?.task.status === "validating";
        });
      }
      // Wait for either a queued task to claim the freed slot, or the queue to
      // have fully drained (no more work to dispatch).
      await waitUntil(async () => {
        const depth = (await service.getAdmissionSnapshot()).queueDepth;
        const nowRunning = acp
          .listSessions()
          .filter((s) => s.status === "running").length;
        return depth === 0 || nowRunning === CAP;
      });
    }

    // ── Zero drops: every task holds exactly one session. ───────────────────
    await waitUntil(
      async () => (await service.getAdmissionSnapshot()).queueDepth === 0,
    );
    expect(acp.listSessions().length).toBe(TOTAL);
    expect((await service.getAdmissionSnapshot()).queueDepth).toBe(0);

    // ── Every task reaches a legal terminal state per the transition table. ─
    for (const id of ids) {
      const doc = await store.getTask(id);
      expect(doc).toBeTruthy();
      const goal = doc?.task.goal ?? "";
      const status = doc?.task.status as OrchestratorTaskStatus;
      if (failTargetGoals.has(goal)) {
        // A crashed task must have gone terminal `failed` via `unrecoverable`.
        expect(status).toBe("failed");
        expect(doc?.events.some((e) => e.eventType === "task_failed")).toBe(
          true,
        );
      } else {
        // A completed task parks at `validating` (AUTO_GOAL_VERIFY off); advance
        // it to `done` the only legal way — through validateTask, which enforces
        // the `validating` precondition and writes the `validation_passed` edge.
        expect(status).toBe("validating");
        // validateTask returns the flat TaskThreadDetailDto (status at top level).
        const after = await service.validateTask(id, {
          passed: true,
          evidence: "acceptance criteria met",
        });
        expect(after?.status).toBe("done");
      }
      const finalStatus = (await store.getTask(id))?.task
        .status as OrchestratorTaskStatus;
      assertLegalTerminal(finalStatus);
    }
    expect(completedCount).toBe(TOTAL - failTargetGoals.size);

    // ── Zero leaked scratch dirs (#13773 regression guard). ─────────────────
    // Close every session — the orchestrator does this on idle-keepAlive reclaim
    // and shutdown. Closing runs the same ownership gate AcpService uses, which
    // must reclaim every isolated `task-*` scratch dir it created. A leaked dir
    // here is a real teardown regression, caught at the filesystem.
    for (const s of acp.listSessions()) {
      await acp.stopSession(s.id);
    }
    const leaked = existsSync(root)
      ? readdirSync(root).filter((name) => name.startsWith("task-"))
      : [];
    expect(leaked).toEqual([]);

    await service.stop();
  });

  it("preserves priority-band order when draining the queue (urgent before normal before low)", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-concurrency-prio-"));
    roots.push(root);
    const acp = new ScratchCapAcp(1, root);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });
    await service.start();

    // cap=1: the first spawns; the rest queue with mixed priorities.
    const active = await newTask(store, "active", "normal");
    await service.spawnAgentForTask(active);
    const low = await newTask(store, "low", "low");
    const urgent = await newTask(store, "urgent", "urgent");
    const normal = await newTask(store, "normal", "normal");
    for (const id of [low, urgent, normal]) {
      await service.spawnAgentForTask(id);
    }

    const snap = await service.getAdmissionSnapshot();
    expect(snap.queueDepth).toBe(3);
    // Dispatch order is priority-band: urgent, normal, low.
    expect(snap.queuedTaskIds).toEqual([urgent, normal, low]);

    await service.stop();
  });
});
