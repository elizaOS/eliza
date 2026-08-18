/**
 * Lifecycle-coherence coverage for OrchestratorTaskService (the 12-message
 * coding-lane defect): archive teardown must stop ACP-alive keepAlive
 * survivors (the contamination vector) with an administrative-stop stamp and
 * without rewriting delivered rows; verify parks must stamp `verifyParkedAt`
 * in BOTH park branches (the forwarder's discriminator); doubled task records
 * for one request must emit exactly one park notice via the router's terminal
 * ledger; and every task-service (re)spawn must carry the task's
 * `spawnRootMessageId` onto the session so the request-voice ledger keys hold
 * across respawns. Deterministic in-process harness: real service + real
 * memory store + a fake ACP (the admission-integration FakeAcp shape).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { ADMIN_STOP_META_KEY } from "../services/admin-stop-marker.ts";
import { MAX_AUTO_VERIFY_ATTEMPTS } from "../services/goal-llm-verifier.ts";
import {
  composeVerifyEscalationNotice,
  OrchestratorTaskService,
} from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import type {
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../services/types.ts";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

const ROOM = "11111111-1111-4111-8111-111111111111";

/** Deterministic ACP stand-in (same shape as stuck-task-reaper.test.ts) with
 * metadata patching + prompt-send hooks for the lifecycle paths under test. */
class FakeAcp {
  static serviceType = AcpService.serviceType;
  readonly sessions = new Map<string, SessionInfo>();
  readonly stopped: string[] = [];
  /** Snapshot of each session's metadata AT THE MOMENT stopSession ran, so
   * the test can assert the admin-stop stamp landed BEFORE the stop. */
  readonly metadataAtStop = new Map<string, Record<string, unknown>>();
  sendToSessionError: Error | null = null;
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
    return {
      maxSessions: 8,
      systemHeadroom: 2,
      activeWorkers: 0,
      activeSystem: 0,
      freeWorkerSlots: 8,
      freeSystemSlots: 2,
    };
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    return this.sessions.get(id) ?? null;
  }

  async updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.metadata = { ...(s.metadata ?? {}), ...patch };
  }

  async stopSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.metadataAtStop.set(id, { ...(s?.metadata ?? {}) });
    this.stopped.push(id);
    if (s) s.status = "stopped";
  }

  async sendToSession(_id: string, _prompt: string): Promise<void> {
    if (this.sendToSessionError) throw this.sendToSessionError;
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
}

function makeRuntime(
  acp: FakeAcp,
  extras: {
    router?: Record<string, unknown>;
    sendMessageToTarget?: (
      target: unknown,
      content: { text: string; agentVoiced?: boolean },
    ) => Promise<unknown>;
    useModel?: (type: string, params: unknown) => Promise<string>;
  } = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000042",
    character: { name: "Lifecycle" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: extras.useModel ?? vi.fn(async () => "{}"),
    reportError: vi.fn(),
    ...(extras.sendMessageToTarget
      ? { sendMessageToTarget: extras.sendMessageToTarget }
      : {}),
    getService: (type: string) => {
      if (type === AcpService.serviceType) return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return extras.router;
      return undefined;
    },
  };
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY",
  "ELIZA_ACP_ADMISSION_QUEUE",
  "ELIZA_ORCHESTRATOR_STUCK_TASK_REAPER",
  "ELIZA_REQUIRE_GOAL_CONTRACT",
];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  process.env.ELIZA_ACP_ADMISSION_QUEUE = "0";
  process.env.ELIZA_ORCHESTRATOR_STUCK_TASK_REAPER = "0";
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function harness(extras?: Parameters<typeof makeRuntime>[1]) {
  const acp = new FakeAcp();
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(
    makeRuntime(acp, extras) as never,
    { store },
  );
  await service.start();
  return { acp, store, service };
}

type PrivateSurface = {
  reEngageOrEscalate: (args: {
    taskId: string;
    sessionId: string;
    correction: string;
    eventType: string;
    verifier: string;
    summary: string;
    missing: string[];
    attempt: number;
  }) => Promise<void>;
  notifyVerifyEscalation: (
    taskId: string,
    details: {
      attempts: number;
      summary: string;
      missing: string[];
      sessionId?: string;
    },
  ) => Promise<void>;
};

describe("archiveTask ACP-truth teardown (contamination survivor)", () => {
  it("stops an ACP-alive session whose task row is already completed, stamps adminStopReason first, and leaves the completed row intact", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "survivor",
      goal: "build the thing",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const acpSession = acp.listSessions()[0];
    expect(acpSession).toBeDefined();
    const sessionId = acpSession?.id as string;
    // Event-bridge outcome: the row goes `completed` while the
    // keepAliveAfterComplete ACP session sits `ready`.
    await store.updateSession(sessionId, { status: "completed" });
    const live = acp.sessions.get(sessionId);
    if (live) live.status = "ready";

    await service.archiveTask(taskId);

    // The ACP session was stopped despite the terminal task-side row...
    expect(acp.stopped).toContain(sessionId);
    // ...with the administrative marker stamped BEFORE the stop...
    expect(acp.metadataAtStop.get(sessionId)?.[ADMIN_STOP_META_KEY]).toBe(
      "task_lifecycle",
    );
    // ...and the delivered `completed` row was NOT rewritten to `stopped`.
    const doc = await store.getTask(taskId);
    expect(doc?.sessions[0]?.status).toBe("completed");
    expect(doc?.task.archived).toBe(true);
  });
});

describe("reEngageOrEscalate verifyParkedAt stamps", () => {
  it("stamps verifyParkedAt in the at-cap park branch even when the task has no origin room", async () => {
    const { acp, store, service } = await harness();
    // No roomId → getTaskOriginTarget returns null → notifyVerifyEscalation
    // early-returns BEFORE stamping verifyEscalationNotifiedAt. verifyParkedAt
    // must land regardless — it is the forwarder's park discriminator.
    const detail = await store.createTask({
      title: "no-origin",
      goal: "goal",
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm",
      summary: "did not verify",
      missing: ["proof"],
      attempt: MAX_AUTO_VERIFY_ATTEMPTS,
    });

    const doc = await store.getTask(taskId);
    expect(typeof doc?.task.metadata?.verifyParkedAt).toBe("string");
    expect(doc?.task.metadata?.verifyEscalationNotifiedAt).toBeUndefined();
  });

  it("stamps verifyParkedAt in the resend-failure park branch", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "resend-fail",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;
    acp.sendToSessionError = new Error("session gone");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm",
      summary: "did not verify",
      missing: ["proof"],
      attempt: 0,
    });

    const doc = await store.getTask(taskId);
    expect(typeof doc?.task.metadata?.verifyParkedAt).toBe("string");
  });
});

describe("park-notice request-level dedupe", () => {
  it("doubled task records for one spawnRootMessageId emit exactly one park notice; the denied task is still stamped", async () => {
    const sends: string[] = [];
    // Minimal terminal ledger: first claim per key wins, later claims from a
    // different holder are denied — the contract shape lane 1 provides.
    const holders = new Map<string, string>();
    const router = {
      claimRequestTerminal: (key: string, sessionId: string) => {
        const holder = holders.get(key);
        if (holder === undefined) {
          holders.set(key, sessionId);
          return { granted: true };
        }
        return holder === sessionId
          ? { granted: true }
          : { granted: false, superseded: false };
      },
    };
    const { store, service } = await harness({
      router,
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const a = await store.createTask({
      title: "request A",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-123" },
    });
    const b = await store.createTask({
      title: "request A (respawned task)",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-123" },
    });

    const svc = service as unknown as PrivateSurface;
    await svc.notifyVerifyEscalation(a.task.id, {
      attempts: 3,
      summary: "gave up",
      missing: [],
      sessionId: "sess-a",
    });
    await svc.notifyVerifyEscalation(b.task.id, {
      attempts: 3,
      summary: "gave up",
      missing: [],
      sessionId: "sess-b",
    });

    expect(sends).toHaveLength(1);
    // BOTH tasks carry the once-per-task stamp — the denied one must never
    // retry the notice later.
    for (const taskId of [a.task.id, b.task.id]) {
      const doc = await store.getTask(taskId);
      expect(typeof doc?.task.metadata?.verifyEscalationNotifiedAt).toBe(
        "string",
      );
    }
  });

  it("keys parks per fan-out lane: sibling lanes each notify once, a doubled lane task is deduped", async () => {
    const sends: string[] = [];
    const holders = new Map<string, string>();
    const claims: string[] = [];
    const router = {
      claimRequestTerminal: (key: string, sessionId: string) => {
        claims.push(key);
        const holder = holders.get(key);
        if (holder === undefined) {
          holders.set(key, sessionId);
          return { granted: true };
        }
        return holder === sessionId
          ? { granted: true }
          : { granted: false, superseded: false };
      },
    };
    const { store, service } = await harness({
      router,
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    // Two GENUINE parallel lanes from one request root, plus a respawn-doubled
    // record of lane A. The composed key (root + part) must let both lanes
    // park audibly while still deduping lane A's doubled record.
    const laneA = await store.createTask({
      title: "lane A",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-9", requestVoicePart: "lane:w:a" },
    });
    const laneB = await store.createTask({
      title: "lane B",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-9", requestVoicePart: "lane:w:b" },
    });
    const laneADoubled = await store.createTask({
      title: "lane A (respawned task)",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-9", requestVoicePart: "lane:w:a" },
    });

    const svc = service as unknown as PrivateSurface;
    const details = { attempts: 3, summary: "gave up", missing: [] };
    await svc.notifyVerifyEscalation(laneA.task.id, {
      ...details,
      sessionId: "sess-a1",
    });
    await svc.notifyVerifyEscalation(laneB.task.id, {
      ...details,
      sessionId: "sess-b1",
    });
    await svc.notifyVerifyEscalation(laneADoubled.task.id, {
      ...details,
      sessionId: "sess-a2",
    });

    // Lane A + lane B each notified; lane A's doubled record was denied.
    expect(sends).toHaveLength(2);
    // The claims were keyed per lane (part-scoped), not per whole request.
    expect(new Set(claims).size).toBe(2);
    // The denied doubled record is still stamped so it never retries.
    const doubled = await store.getTask(laneADoubled.task.id);
    expect(typeof doubled?.task.metadata?.verifyEscalationNotifiedAt).toBe(
      "string",
    );
  });

  it("prefers the parking session's own metadata for the claim key (matches the router's ladder)", async () => {
    const sends: string[] = [];
    const claims: string[] = [];
    const router = {
      claimRequestTerminal: (key: string) => {
        claims.push(key);
        return { granted: true };
      },
    };
    const { acp, store, service } = await harness({
      router,
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    // Task record predates the stamp (no spawnRootMessageId in task metadata)
    // but the parking session carries it — the router keyed that session's
    // terminal claims on the session metadata, so the park must claim the
    // SAME key rather than degrading to task:<taskId>.
    const detail = await store.createTask({
      title: "session-keyed",
      goal: "goal",
      roomId: ROOM,
    });
    await service.spawnAgentForTask(detail.task.id);
    const sessionId = acp.listSessions()[0]?.id as string;
    await acp.updateSessionMetadata(sessionId, {
      spawnRootMessageId: "req-session-55",
    });

    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      { attempts: 3, summary: "gave up", missing: [], sessionId },
    );

    expect(sends).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("req-session-55");
    expect(claims[0]).not.toContain(`task:${detail.task.id}`);
  });

  it("posts the model-phrased notice (title intact, agent-voiced) when the model produces valid output", async () => {
    const sends: Array<{ text: string; agentVoiced?: boolean }> = [];
    const phrased =
      "Quick heads up — I parked parked-build for you after verification kept coming up short. The work itself might be fine; take a look and tell me to accept it or what to fix.";
    const { store, service } = await harness({
      useModel: async () => phrased,
      sendMessageToTarget: async (_target, content) => {
        sends.push(content);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const detail = await store.createTask({
      title: "parked-build",
      goal: "goal",
      roomId: ROOM,
    });
    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      { attempts: 3, summary: "gave up", missing: [] },
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe(phrased);
    expect(sends[0]?.agentVoiced).toBe(true);
  });

  it("falls back to the deterministic composeVerifyEscalationNotice text when the model rejects", async () => {
    const sends: Array<{ text: string; agentVoiced?: boolean }> = [];
    const { store, service } = await harness({
      useModel: async () => {
        throw new Error("model down");
      },
      sendMessageToTarget: async (_target, content) => {
        sends.push(content);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const detail = await store.createTask({
      title: "parked-build",
      goal: "goal",
      roomId: ROOM,
    });
    const details = { attempts: 3, summary: "gave up", missing: ["proof"] };
    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      details,
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe(
      composeVerifyEscalationNotice("parked-build", details),
    );
    // Facts survive the outage: title, attempts, and the missing item.
    expect(sends[0]?.text).toContain("parked-build");
    expect(sends[0]?.text).toContain("3 attempts");
    expect(sends[0]?.text).toContain("proof");
  });

  it("rejects phrased output that drops the title (mustInclude) and uses the fallback", async () => {
    const sends: Array<{ text: string }> = [];
    const { store, service } = await harness({
      useModel: async () => "I parked the thing, check it later.",
      sendMessageToTarget: async (_target, content) => {
        sends.push(content);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const detail = await store.createTask({
      title: "parked-build",
      goal: "goal",
      roomId: ROOM,
    });
    const details = { attempts: 2, summary: "gave up", missing: [] };
    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      details,
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe(
      composeVerifyEscalationNotice("parked-build", details),
    );
  });

  it("sends as today when the router is absent (fail-open)", async () => {
    const sends: string[] = [];
    const { store, service } = await harness({
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const detail = await store.createTask({
      title: "no-router",
      goal: "goal",
      roomId: ROOM,
    });
    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      { attempts: 3, summary: "gave up", missing: [] },
    );
    expect(sends).toHaveLength(1);
  });
});

describe("stopActiveSessions without ACP", () => {
  it("keeps the stop_failed + interrupted behavior and throws", async () => {
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const runtime = makeRuntime(acp);
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();
    const detail = await store.createTask({
      title: "no-acp",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;
    // Row is live on the task side, then ACP vanishes.
    (runtime as { getService: unknown }).getService = () => undefined;

    await expect(service.archiveTask(taskId)).rejects.toThrow(
      /ACP service unavailable/,
    );
    const doc = await store.getTask(taskId);
    expect(doc?.sessions.find((s) => s.sessionId === sessionId)?.status).toBe(
      "stop_failed",
    );
  });
});

describe("spawnAgentForTask request-voice carry", () => {
  it("carries the task's spawnRootMessageId onto every spawned session's metadata", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "carry",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-777" },
    });
    await service.spawnAgentForTask(detail.task.id);
    const session = acp.listSessions()[0];
    expect(session?.metadata?.spawnRootMessageId).toBe("req-777");
  });

  it("carries the task's requestVoicePart alongside the root so lane respawns keep their lane's slot", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "lane-carry",
      goal: "goal",
      roomId: ROOM,
      metadata: { spawnRootMessageId: "req-777", requestVoicePart: "lane:w:a" },
    });
    await service.spawnAgentForTask(detail.task.id);
    const session = acp.listSessions()[0];
    expect(session?.metadata?.spawnRootMessageId).toBe("req-777");
    expect(session?.metadata?.requestVoicePart).toBe("lane:w:a");
  });

  it("omits the key when the task metadata lacks the stamp (degraded mode)", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "no-carry",
      goal: "goal",
      roomId: ROOM,
    });
    await service.spawnAgentForTask(detail.task.id);
    const session = acp.listSessions()[0];
    expect(session?.metadata?.spawnRootMessageId).toBeUndefined();
    expect(session?.metadata?.requestVoicePart).toBeUndefined();
  });
});

describe("wantsPullRequest (auto-submit intent gate)", () => {
  it("matches natural PR asks", () => {
    for (const text of [
      "add hello.md and open a pull request",
      "commit, push, open a PR. only that repo",
      "hey can u add a hello.md to my repo and pr it",
      "make a merge request for this",
    ]) {
      expect(OrchestratorTaskService.wantsPullRequest(text)).toBe(true);
    }
  });

  it("stays quiet for repo work without PR intent", () => {
    for (const text of [
      "fix the failing test in my sandbox repo",
      "clone the repo and summarize the readme",
      "improve the prompt wording",
      // Negated PR mentions are declines, not asks (live 2026-08-18: the
      // bare \bpr\b token in "no pr needed" opened the declined PR).
      "fix the typo in the readme, just commit it locally no pr needed",
      "commit the change but don't open a pr",
      "update the docs, skip the pull request",
      "push nothing and never open a pr for this",
    ]) {
      expect(OrchestratorTaskService.wantsPullRequest(text)).toBe(false);
    }
  });
});
