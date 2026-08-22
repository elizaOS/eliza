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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { ADMIN_STOP_META_KEY } from "../services/admin-stop-marker.ts";
import { readDurableContent } from "../services/durable-content-store.ts";
import { MAX_AUTO_VERIFY_ATTEMPTS } from "../services/goal-llm-verifier.ts";
import {
  composeVerifyEscalationNotice,
  OrchestratorTaskService,
} from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";
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
    workspaceService?: unknown;
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
      if (type === "CODING_WORKSPACE_SERVICE") return extras.workspaceService;
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

async function harness(
  extras?: Parameters<typeof makeRuntime>[1],
  opts: { store?: OrchestratorTaskStore } = {},
) {
  const acp = new FakeAcp();
  const store = opts.store ?? new OrchestratorTaskStore({ backend: "memory" });
  const runtime = makeRuntime(acp, extras);
  const service = new OrchestratorTaskService(runtime as never, { store });
  await service.start();
  return { acp, store, service, runtime };
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

describe("phrased park notice receives the complete missing list", () => {
  it("hands every missing item to the phrasing model, not just the first three", async () => {
    const prompts: string[] = [];
    const sends: string[] = [];
    const { store, service } = await harness({
      useModel: async (_type, params) => {
        prompts.push(JSON.stringify(params));
        return "Heads up — I parked full-list for you; check it and tell me what to fix.";
      },
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    });
    const detail = await store.createTask({
      title: "full-list",
      goal: "goal",
      roomId: ROOM,
    });
    await (service as unknown as PrivateSurface).notifyVerifyEscalation(
      detail.task.id,
      {
        attempts: 3,
        summary: "gave up",
        missing: ["m1", "m2", "m3", "m4", "m5"],
      },
    );
    expect(sends).toHaveLength(1);
    // Prompt integrity: items past the old slice(0, 3) reach the model.
    const phrasingInput = prompts.join("\n");
    expect(phrasingInput).toContain("m4");
    expect(phrasingInput).toContain("m5");
  });
});

describe("completionSummary durable projection", () => {
  let trajDir: string;
  let savedTrajEnv: string | undefined;

  beforeEach(() => {
    trajDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-svc-traj-"));
    savedTrajEnv = process.env.ELIZA_TRAJECTORY_DIR;
    process.env.ELIZA_TRAJECTORY_DIR = trajDir;
  });

  afterEach(() => {
    if (savedTrajEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
    else process.env.ELIZA_TRAJECTORY_DIR = savedTrajEnv;
    fs.rmSync(trajDir, { recursive: true, force: true });
  });

  it("stores an oversized final response as a marker-bearing preview whose route resolves to the full text", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "long-finish",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;
    const fullResponse = `done: ${"R".repeat(3_000)}`;

    acp.emit(sessionId, "task_complete", { response: fullResponse });
    // The event bridge is async; poll until the session row lands.
    let summary: string | undefined;
    for (let i = 0; i < 50 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 10));
      summary = (await store.getTask(taskId))?.sessions.find(
        (row) => row.sessionId === sessionId,
      )?.completionSummary;
    }

    expect(summary).toBeDefined();
    expect((summary as string).length).toBeLessThanOrEqual(2_000);
    const sha = /\/api\/orchestrator\/content\/([0-9a-f]{64})/u.exec(
      summary as string,
    )?.[1];
    expect(
      sha,
      "preview must carry the resolvable content route",
    ).toBeDefined();
    expect(readDurableContent(sha as string, { limit: 1_048_576 })?.text).toBe(
      fullResponse,
    );
    // The COMPLETE response also rides the durable task_complete event row.
    const event = (await store.getTask(taskId))?.events.find(
      (row) => row.eventType === "task_complete",
    );
    expect(event?.data.response).toBe(fullResponse);
  });

  it("stores a short final response whole, with no marker", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "short-finish",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;

    acp.emit(sessionId, "task_complete", { response: "all done" });
    let summary: string | undefined;
    for (let i = 0; i < 50 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 10));
      summary = (await store.getTask(taskId))?.sessions.find(
        (row) => row.sessionId === sessionId,
      )?.completionSummary;
    }
    expect(summary).toBe("all done");
  });
});

describe("child-trajectory ingest overflow manifest", () => {
  let stateDir: string;
  let savedStateEnv: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-svc-state-"));
    savedStateEnv = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (savedStateEnv === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = savedStateEnv;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  type IngestSurface = {
    ingestChildTrajectories(
      taskId: string,
      sessionId: string,
    ): Promise<string[]>;
  };

  it("caps rows at the newest 20 but records the dropped count and the durable dir, then drains on the next pass", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "overflow",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;

    const dir = path.join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now();
    for (let i = 0; i < 25; i++) {
      const file = path.join(dir, `traj-${String(i).padStart(2, "0")}.json`);
      fs.writeFileSync(file, "{}", "utf8");
      // traj-00 is newest; traj-24 is oldest.
      const when = new Date(base - i * 60_000);
      fs.utimesSync(file, when, when);
    }

    const ingested = await (
      service as unknown as IngestSurface
    ).ingestChildTrajectories(taskId, sessionId);
    expect(ingested).toHaveLength(20);
    // The 5 oldest were dropped from this pass.
    for (const id of ["traj-20", "traj-21", "traj-22", "traj-23", "traj-24"]) {
      expect(ingested).not.toContain(id);
    }

    const doc = await store.getTask(taskId);
    const trajectoryRows = (doc?.artifacts ?? []).filter(
      (a) => a.artifactType === "trajectory",
    );
    const overflow = trajectoryRows.filter(
      (a) => (a.metadata as { overflow?: unknown } | undefined)?.overflow,
    );
    expect(trajectoryRows).toHaveLength(21);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.path).toBe(dir);
    const overflowMeta = overflow[0]?.metadata as
      | { overflow: { droppedCount: number } }
      | undefined;
    expect(overflowMeta?.overflow.droppedCount).toBe(5);
    expect(overflow[0]?.title).toContain("5 additional file(s)");

    // Nothing was lost: the next completion pass ingests the remainder and
    // records no further overflow.
    const second = await (
      service as unknown as IngestSurface
    ).ingestChildTrajectories(taskId, sessionId);
    expect(second.sort()).toEqual([
      "traj-20",
      "traj-21",
      "traj-22",
      "traj-23",
      "traj-24",
    ]);
    const after = await store.getTask(taskId);
    const afterOverflow = (after?.artifacts ?? []).filter(
      (a) => (a.metadata as { overflow?: unknown } | undefined)?.overflow,
    );
    expect(afterOverflow).toHaveLength(1);
    expect(
      (after?.artifacts ?? []).filter((a) => a.artifactType === "trajectory"),
    ).toHaveLength(26);
  });

  it("adds no overflow row when the fresh file count fits the cap", async () => {
    const { acp, store, service } = await harness();
    const detail = await store.createTask({
      title: "no-overflow",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;

    const dir = path.join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
    );
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, `traj-${i}.json`), "{}", "utf8");
    }

    const ingested = await (
      service as unknown as IngestSurface
    ).ingestChildTrajectories(taskId, sessionId);
    expect(ingested).toHaveLength(3);
    const doc = await store.getTask(taskId);
    expect(
      (doc?.artifacts ?? []).filter(
        (a) => (a.metadata as { overflow?: unknown } | undefined)?.overflow,
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-submit: typed intent authority + durable exactly-once claim (#PR-task-
// service review). Real service + real memory store + real git repo on disk;
// the workspace service is a real CodingWorkspaceService instance with its
// remote-touching legs (getWorkspace/push/createPR) stubbed.
// ---------------------------------------------------------------------------

type SubmitPrivate = {
  autoSubmitProvisionedWorkspace: (
    taskId: string,
    sessionId: string,
  ) => Promise<void>;
};

/** Real git repo with one commit standing in for the child's committed work. */
function makeChildRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-auto-submit-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
  git("config", "user.email", "orchestrator-test@example.com");
  git("config", "user.name", "Orchestrator Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "work.txt"), "child work\n");
  git("add", "work.txt");
  git("commit", "-q", "-m", "child work");
  return dir;
}

/** Real CodingWorkspaceService (instanceof matters to the service resolver)
 * with the registry lookup and remote git legs stubbed. */
function makeWorkspaceFake(repoDir: string) {
  const wsService = new CodingWorkspaceService(
    {
      getSetting: () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "orch-ws-base-")) },
  );
  const workspace = {
    id: "ws-1",
    path: repoDir,
    branch: "eliza/pr-branch",
  } as unknown as ReturnType<CodingWorkspaceService["getWorkspace"]>;
  const push = vi.fn(async () => undefined);
  const createPR = vi.fn(async () => ({
    url: "https://github.com/acme/widgets/pull/7",
    number: 7,
  }));
  wsService.getWorkspace = vi.fn(() => workspace) as never;
  wsService.push = push as never;
  wsService.createPR = createPR as never;
  return { wsService, push, createPR };
}

/** Task created through the REAL createTask path (typed intent derivation),
 * spawned onto the fake ACP, with the session tagged as workspace-backed. */
async function provisionedTask(
  service: OrchestratorTaskService,
  acp: FakeAcp,
  goal: string,
  metadata?: Record<string, unknown>,
) {
  const detail = await service.createTask({
    title: "auto-submit",
    goal,
    ...(metadata ? { metadata } : {}),
  });
  const taskId = detail.id;
  await service.spawnAgentForTask(taskId);
  const sessionId = acp.listSessions().at(-1)?.id as string;
  await acp.updateSessionMetadata(sessionId, {
    provisionedWorkspaceId: "ws-1",
  });
  return { taskId, sessionId };
}

describe("typed submitIntent is the persisted auto-submit authority", () => {
  it("derives and persists submitIntent from the request text at create time", async () => {
    const { store, service } = await harness();
    const asked = await service.createTask({
      title: "pr-ask",
      goal: "add hello.md and open a pull request",
    });
    expect((await store.getTask(asked.id))?.task.metadata?.submitIntent).toBe(
      true,
    );
    const declined = await service.createTask({
      title: "pr-declined",
      goal: "fix the typo in the readme, just commit it locally no pr needed",
    });
    expect(
      (await store.getTask(declined.id))?.task.metadata?.submitIntent,
    ).toBe(false);
  });

  it("honors an explicit caller-supplied submitIntent boolean over prose", async () => {
    const { store, service } = await harness();
    const optedOut = await service.createTask({
      title: "opt-out",
      goal: "add hello.md and open a pull request",
      metadata: { submitIntent: false },
    });
    expect(
      (await store.getTask(optedOut.id))?.task.metadata?.submitIntent,
    ).toBe(false);
    const optedIn = await service.createTask({
      title: "opt-in",
      goal: "improve the prompt wording",
      metadata: { submitIntent: true },
    });
    expect((await store.getTask(optedIn.id))?.task.metadata?.submitIntent).toBe(
      true,
    );
  });

  it("never submits from goal prose alone: a record without the typed field is skipped even when the goal asks for a PR", async () => {
    const repoDir = makeChildRepo();
    const { wsService, push, createPR } = makeWorkspaceFake(repoDir);
    const { acp, store, service } = await harness({
      workspaceService: wsService,
    });
    // Old-style record created straight on the store — PR prose, no typed
    // field (what the removed completion-time regex used to act on).
    const detail = await store.createTask({
      title: "prose-only",
      goal: "add hello.md and open a pull request",
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;
    await acp.updateSessionMetadata(sessionId, {
      provisionedWorkspaceId: "ws-1",
    });

    await (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
      taskId,
      sessionId,
    );

    expect(createPR).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(meta.autoSubmitClaimedAt).toBeUndefined();
    expect(meta.autoSubmittedAt).toBeUndefined();
  });

  it("submits from the typed field even when the goal prose has no PR wording", async () => {
    const repoDir = makeChildRepo();
    const { wsService, createPR } = makeWorkspaceFake(repoDir);
    const { acp, store, service } = await harness({
      workspaceService: wsService,
    });
    const { taskId, sessionId } = await provisionedTask(
      service,
      acp,
      "improve the prompt wording",
      { submitIntent: true },
    );

    await (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
      taskId,
      sessionId,
    );

    expect(createPR).toHaveBeenCalledTimes(1);
    const meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(meta.autoSubmittedPrUrl).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
  });
});

describe("auto-submit durable exactly-once claim", () => {
  it("two concurrent completion drives open exactly one PR", async () => {
    const repoDir = makeChildRepo();
    const { wsService, push, createPR } = makeWorkspaceFake(repoDir);
    const { acp, store, service } = await harness({
      workspaceService: wsService,
    });
    const { taskId, sessionId } = await provisionedTask(
      service,
      acp,
      "add hello.md and open a pull request",
    );

    const drive = () =>
      (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
        taskId,
        sessionId,
      );
    await Promise.all([drive(), drive()]);

    expect(createPR).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    const meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(typeof meta.autoSubmitClaimedAt).toBe("string");
    expect(typeof meta.autoSubmittedAt).toBe("string");
    expect(meta.prUrl).toBe("https://github.com/acme/widgets/pull/7");
  });

  it("a completion redelivered to a restarted service takes the sync leg, never a second PR", async () => {
    const repoDir = makeChildRepo();
    const { wsService, createPR } = makeWorkspaceFake(repoDir);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const first = await harness({ workspaceService: wsService }, { store });
    const { taskId, sessionId } = await provisionedTask(
      first.service,
      first.acp,
      "add hello.md and open a pull request",
    );
    await (
      first.service as unknown as SubmitPrivate
    ).autoSubmitProvisionedWorkspace(taskId, sessionId);
    expect(createPR).toHaveBeenCalledTimes(1);

    // Service restart: fresh service + fresh ACP, SAME durable store. The
    // in-memory lock is gone — only the persisted claim protects the task.
    const second = await harness({ workspaceService: wsService }, { store });
    second.acp.sessions.set(sessionId, {
      id: sessionId,
      name: sessionId,
      agentType: "opencode",
      workdir: repoDir,
      status: "completed",
      approvalPreset: "standard",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: { provisionedWorkspaceId: "ws-1" },
    });
    await (
      second.service as unknown as SubmitPrivate
    ).autoSubmitProvisionedWorkspace(taskId, sessionId);

    expect(createPR).toHaveBeenCalledTimes(1);
    const meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(meta.autoSubmittedPrUrl).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
  });

  it("a persisted claim from a crashed submit blocks re-submit across restart", async () => {
    const repoDir = makeChildRepo();
    const { wsService, push, createPR } = makeWorkspaceFake(repoDir);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const first = await harness({ workspaceService: wsService }, { store });
    const { taskId, sessionId } = await provisionedTask(
      first.service,
      first.acp,
      "add hello.md and open a pull request",
    );
    // Simulate a crash mid-submit: the durable claim landed, the submit never
    // finished (no autoSubmittedAt, no PR).
    const doc = await store.getTask(taskId);
    await store.updateTask(taskId, {
      metadata: {
        ...(doc?.task.metadata ?? {}),
        autoSubmitClaimedAt: new Date().toISOString(),
      },
    });

    const second = await harness({ workspaceService: wsService }, { store });
    second.acp.sessions.set(sessionId, {
      id: sessionId,
      name: sessionId,
      agentType: "opencode",
      workdir: repoDir,
      status: "completed",
      approvalPreset: "standard",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: { provisionedWorkspaceId: "ws-1" },
    });
    await (
      second.service as unknown as SubmitPrivate
    ).autoSubmitProvisionedWorkspace(taskId, sessionId);

    expect(createPR).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("a failed submit re-arms the claim so a later completion can retry", async () => {
    const repoDir = makeChildRepo();
    const { wsService, createPR } = makeWorkspaceFake(repoDir);
    const { acp, store, service } = await harness({
      workspaceService: wsService,
    });
    const { taskId, sessionId } = await provisionedTask(
      service,
      acp,
      "add hello.md and open a pull request",
    );
    createPR.mockRejectedValueOnce(new Error("gh 502"));

    const drive = () =>
      (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
        taskId,
        sessionId,
      );
    await drive();
    expect(createPR).toHaveBeenCalledTimes(1);
    let meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(meta.autoSubmitClaimedAt).toBeUndefined();
    expect(meta.autoSubmittedAt).toBeUndefined();
    expect(meta.autoSubmittedPrUrl).toBeUndefined();

    await drive();
    expect(createPR).toHaveBeenCalledTimes(2);
    meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(typeof meta.autoSubmittedAt).toBe("string");
    expect(meta.autoSubmittedPrUrl).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
  });

  it("keeps the claim when the PR was created and only a later leg failed", async () => {
    const repoDir = makeChildRepo();
    const { wsService, createPR } = makeWorkspaceFake(repoDir);
    // The user-notify leg throws AFTER createPR succeeded: the claim must
    // NOT re-arm (a redelivered completion would open a duplicate PR).
    const sendMessageToTarget = vi.fn(async () => {
      throw new Error("connector offline");
    });
    const { acp, store, service } = await harness({
      workspaceService: wsService,
      sendMessageToTarget,
    });
    const detail = await service.createTask({
      title: "notify-fails",
      goal: "add hello.md and open a pull request",
      roomId: ROOM,
      metadata: { source: "discord" },
    });
    const taskId = detail.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions().at(-1)?.id as string;
    await acp.updateSessionMetadata(sessionId, {
      provisionedWorkspaceId: "ws-1",
    });

    const drive = () =>
      (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
        taskId,
        sessionId,
      );
    await drive();
    expect(createPR).toHaveBeenCalledTimes(1);
    expect(sendMessageToTarget).toHaveBeenCalled();
    const meta = (await store.getTask(taskId))?.task.metadata ?? {};
    expect(typeof meta.autoSubmittedAt).toBe("string");
    expect(typeof meta.autoSubmitClaimedAt).toBe("string");

    // The redelivered completion takes the sync leg — never a second PR.
    await drive();
    expect(createPR).toHaveBeenCalledTimes(1);
  });

  it("two racing task_complete events through the real bridge open exactly one PR", async () => {
    const repoDir = makeChildRepo();
    const { wsService, createPR } = makeWorkspaceFake(repoDir);
    const { acp, store, service } = await harness({
      workspaceService: wsService,
    });
    const { taskId, sessionId } = await provisionedTask(
      service,
      acp,
      "add hello.md and open a pull request",
    );

    // ACP can emit task_complete from two sites for one turn — replay that.
    acp.emit(sessionId, "task_complete", { response: "done" });
    acp.emit(sessionId, "task_complete", { response: "done" });

    let prUrl: unknown;
    for (let i = 0; i < 200 && !prUrl; i++) {
      await new Promise((r) => setTimeout(r, 25));
      prUrl = (await store.getTask(taskId))?.task.metadata?.autoSubmittedPrUrl;
    }
    expect(prUrl).toBe("https://github.com/acme/widgets/pull/7");
    // Let the losing drive fully settle, then assert exact-once.
    await new Promise((r) => setTimeout(r, 250));
    expect(createPR).toHaveBeenCalledTimes(1);
  });
});

describe("completion-path diagnostics are reported, not swallowed", () => {
  it("reports corrective-lap event persistence failures through runtime.reportError", async () => {
    const repoDir = makeChildRepo();
    const { wsService } = makeWorkspaceFake(repoDir);
    // Corrective lap against a workspace that is no longer registered.
    wsService.getWorkspace = vi.fn(() => undefined) as never;
    const { acp, store, service, runtime } = await harness({
      workspaceService: wsService,
    });
    const { taskId, sessionId } = await provisionedTask(
      service,
      acp,
      "add hello.md and open a pull request",
    );
    const doc = await store.getTask(taskId);
    await store.updateTask(taskId, {
      metadata: {
        ...(doc?.task.metadata ?? {}),
        autoSubmittedAt: new Date().toISOString(),
      },
    });
    (store as unknown as { addEvent: () => Promise<never> }).addEvent = vi.fn(
      async () => {
        throw new Error("db down");
      },
    );

    await (service as unknown as SubmitPrivate).autoSubmitProvisionedWorkspace(
      taskId,
      sessionId,
    );

    expect(runtime.reportError).toHaveBeenCalledWith(
      "OrchestratorTaskService.autoSubmitProvisionedWorkspace",
      expect.any(Error),
      expect.objectContaining({
        taskId,
        sessionId,
        phase: "corrective_push_failed_event",
      }),
    );
  });

  it("terminates the detached verification promise through runtime.reportError", async () => {
    const { acp, store, service, runtime } = await harness();
    const detail = await store.createTask({
      title: "verify-terminal",
      goal: "goal",
      roomId: ROOM,
    });
    const taskId = detail.task.id;
    await service.spawnAgentForTask(taskId);
    const sessionId = acp.listSessions()[0]?.id as string;
    Object.assign(service as object, {
      buildCompletionEvidence: vi.fn(async () => {
        throw new Error("evidence assembly exploded");
      }),
    });

    acp.emit(sessionId, "task_complete", { response: "done" });

    const reportError = runtime.reportError as ReturnType<typeof vi.fn>;
    let reported = false;
    for (let i = 0; i < 200 && !reported; i++) {
      await new Promise((r) => setTimeout(r, 10));
      reported = reportError.mock.calls.some(
        (call) => call[0] === "OrchestratorTaskService.autoVerifyCompletion",
      );
    }
    expect(reported).toBe(true);
    const call = reportError.mock.calls.find(
      (c) => c[0] === "OrchestratorTaskService.autoVerifyCompletion",
    );
    expect(call?.[1]).toBeInstanceOf(Error);
    expect(call?.[2]).toMatchObject({ taskId, sessionId });
  });
});
