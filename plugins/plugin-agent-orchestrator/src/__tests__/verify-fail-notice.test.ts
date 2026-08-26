/**
 * Never-silent failed-verdict coverage for OrchestratorTaskService (live
 * incident 2026-08-25, chart-dep-check / tj-efb29068fa9fdc): a failed goal
 * verdict for a SYSTEM-terminal (interrupted/failed) task must post an honest
 * "the build stopped" notice to the origin room — the deferred completion
 * relay was already dropped on the fail verdict, so this notice is the only
 * voice left; a USER-stopped task stays silent (the stop confirmation was the
 * notice); and the resend-failure park (dead worker) posts the unreachable
 * notice instead of parking silently. All legs share the per-task notice
 * stamp and the router's request-terminal ledger, so park + fail can never
 * double-post. Deterministic in-process harness: real service + real memory
 * store + a fake ACP (the orchestrator-task-service.test.ts shape).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import {
  composeVerifyFailureNotice,
  OrchestratorTaskService,
} from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import type {
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../services/types.ts";

const ROOM = "11111111-1111-4111-8111-111111111111";

// The byte-exact verdict summary from the incident's goal-verify trajectory.
const INCIDENT_SUMMARY =
  "The sub-agent failed to produce any deliverables and explicitly stated that the runtime failed before results could be produced.";
const INCIDENT_MISSING = [
  "a report file exists in the workdir documenting the chart dependency hierarchy",
  "the report explicitly lists each chart-related dependency and its current version",
  "typecheck passes",
];

/** Deterministic ACP stand-in (same shape as orchestrator-task-service.test.ts). */
class FakeAcp {
  static serviceType = AcpService.serviceType;
  readonly sessions = new Map<string, SessionInfo>();
  sendToSessionError: Error | null = null;
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
    if (s) s.status = "stopped";
  }

  async sendToSession(_id: string, _prompt: string): Promise<void> {
    if (this.sendToSessionError) throw this.sendToSessionError;
  }

  onSessionEvent(): () => void {
    return () => {};
  }

  getChangedPaths(): string[] {
    return [];
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
  } = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000042",
    character: { name: "Lifecycle" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: vi.fn(async () => "{}"),
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
};

async function spawnIncidentTask(
  store: OrchestratorTaskStore,
  service: OrchestratorTaskService,
  acp: FakeAcp,
) {
  const detail = await store.createTask({
    title: "Chart Dependency Investigation",
    goal: "Dig through it",
    roomId: ROOM,
  });
  const taskId = detail.task.id;
  await service.spawnAgentForTask(taskId);
  const sessionId = acp.listSessions()[0]?.id as string;
  return { taskId, sessionId };
}

describe("failed verdict on a system-terminal task (the incident shape)", () => {
  it("posts an honest stopped notice to the origin room instead of silence", async () => {
    const sends: string[] = [];
    const { acp, store, service } = await harness({
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m" };
      },
    });
    const { taskId, sessionId } = await spawnIncidentTask(store, service, acp);
    // System interruption (stuck-task reaper / crash), NOT a user stop.
    await service.interruptTask(taskId, "stalled_reaped");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm-goal-verifier",
      summary: INCIDENT_SUMMARY,
      missing: INCIDENT_MISSING,
      attempt: 0,
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Chart Dependency Investigation");
    expect(sends[0]).toContain("stopped before it could finish");
    expect(sends[0]).toContain(INCIDENT_SUMMARY);
    // Nothing may read as success or as still-running work.
    expect(sends[0]).not.toMatch(/\bfinished\b/i);
    const doc = await store.getTask(taskId);
    expect(typeof doc?.task.metadata?.verifyEscalationNotifiedAt).toBe(
      "string",
    );
  });

  it("stays silent for a user-stopped task (the stop confirmation was the notice)", async () => {
    const sends: string[] = [];
    const { acp, store, service } = await harness({
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m" };
      },
    });
    const { taskId, sessionId } = await spawnIncidentTask(store, service, acp);
    await service.interruptTask(taskId, "user_interrupt");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm-goal-verifier",
      summary: INCIDENT_SUMMARY,
      missing: INCIDENT_MISSING,
      attempt: 0,
    });

    expect(sends).toHaveLength(0);
  });

  it("dedupes: an already-posted park notice suppresses the stopped notice", async () => {
    const sends: string[] = [];
    const { acp, store, service } = await harness({
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m" };
      },
    });
    const { taskId, sessionId } = await spawnIncidentTask(store, service, acp);
    const doc = await store.getTask(taskId);
    await store.updateTask(taskId, {
      metadata: {
        ...(doc?.task.metadata ?? {}),
        verifyEscalationNotifiedAt: new Date().toISOString(),
      },
    });
    await service.interruptTask(taskId, "stalled_reaped");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm-goal-verifier",
      summary: INCIDENT_SUMMARY,
      missing: INCIDENT_MISSING,
      attempt: 0,
    });

    expect(sends).toHaveLength(0);
  });

  it("claims the request's FAILURE terminal; a denied claim suppresses the send but still stamps", async () => {
    const sends: string[] = [];
    const claims: Array<{ kind: string }> = [];
    const router = {
      claimRequestTerminal: (
        _key: string,
        _sessionId: string,
        kind: string,
      ) => {
        claims.push({ kind });
        // A crash narration already holds this lineage's failure terminal.
        return { granted: false, superseded: false };
      },
    };
    const { acp, store, service } = await harness({
      router,
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m" };
      },
    });
    const { taskId, sessionId } = await spawnIncidentTask(store, service, acp);
    await service.interruptTask(taskId, "stalled_reaped");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm-goal-verifier",
      summary: INCIDENT_SUMMARY,
      missing: INCIDENT_MISSING,
      attempt: 0,
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("failure");
    expect(sends).toHaveLength(0);
    const doc = await store.getTask(taskId);
    expect(typeof doc?.task.metadata?.verifyEscalationNotifiedAt).toBe(
      "string",
    );
  });
});

describe("resend-failure park (dead worker)", () => {
  it("posts the unreachable notice instead of parking silently", async () => {
    const sends: string[] = [];
    const { acp, store, service } = await harness({
      sendMessageToTarget: async (_target, content) => {
        sends.push(content.text);
        return { id: "m" };
      },
    });
    const { taskId, sessionId } = await spawnIncidentTask(store, service, acp);
    acp.sendToSessionError = new Error("session gone");

    await (service as unknown as PrivateSurface).reEngageOrEscalate({
      taskId,
      sessionId,
      correction: "fix it",
      eventType: "auto_verify_failed",
      verifier: "llm-goal-verifier",
      summary: INCIDENT_SUMMARY,
      missing: INCIDENT_MISSING,
      attempt: 0,
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("couldn't reach the worker");
    expect(sends[0]).toContain("Chart Dependency Investigation");
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("waiting_on_user");
    expect(typeof doc?.task.metadata?.verifyParkedAt).toBe("string");
    expect(typeof doc?.task.metadata?.verifyEscalationNotifiedAt).toBe(
      "string",
    );
  });
});

describe("composeVerifyFailureNotice", () => {
  const details = {
    attempts: 1,
    summary: INCIDENT_SUMMARY,
    missing: INCIDENT_MISSING,
  };

  it("parked delegates to the established give-up wording", () => {
    const text = composeVerifyFailureNotice("t", details, "parked");
    expect(text).toContain("gave up after 1 attempts");
    expect(text).toContain("waiting on you");
  });

  it("stopped is honest that the build is over and offers a retry", () => {
    const text = composeVerifyFailureNotice("t", details, "stopped");
    expect(text).toContain("stopped before it could finish");
    expect(text).toContain(INCIDENT_SUMMARY);
    expect(text).toContain("Nothing is running for it now");
    expect(text).not.toMatch(/waiting on you/i);
  });

  it("unreachable says the fix could not be delivered", () => {
    const text = composeVerifyFailureNotice("t", details, "unreachable");
    expect(text).toContain("couldn't reach the worker");
    expect(text).toContain("waiting on you");
  });
});
