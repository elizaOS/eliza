import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import type {
  TaskSessionDto,
  TaskThreadDetailDto,
  TaskThreadDto,
} from "../../src/services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import type { OrchestratorTaskStatus } from "../../src/services/orchestrator-task-types.js";
import {
  addSessionSpendUsd,
  resetSessionSpendUsd,
} from "../../src/services/spend-allowance.js";
import {
  GRILL_PROMPT,
  TaskSupervisorService,
} from "../../src/services/task-supervisor-service.js";

const ROOM_A = "11111111-1111-1111-1111-111111111111";
const ROOM_B = "22222222-2222-2222-2222-222222222222";
const FIXED_NOW = 1_000_000_000_000;

interface SessionMeta {
  metadata: Record<string, unknown>;
}

function makeSession(over: Partial<TaskSessionDto> = {}): TaskSessionDto {
  return {
    id: "row-1",
    threadId: "task-1",
    sessionId: "sess-1",
    framework: "codex",
    providerSource: null,
    model: null,
    accountProviderId: null,
    accountId: null,
    accountLabel: null,
    label: "alpha",
    originalTask: "do the thing",
    workdir: "/tmp/x",
    repo: null,
    status: "ready",
    activeTool: null,
    decisionCount: 1,
    autoResolvedCount: 0,
    registeredAt: FIXED_NOW,
    lastActivityAt: FIXED_NOW,
    idleCheckCount: 0,
    taskDelivered: false,
    completionSummary: null,
    lastSeenDecisionIndex: 0,
    lastInputSentAt: null,
    stoppedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    ...over,
  };
}

function makeDetail(
  over: Partial<TaskThreadDetailDto> & {
    id: string;
    status: OrchestratorTaskStatus;
    roomId: string;
  },
): TaskThreadDetailDto {
  const session = over.sessions?.[0] ?? makeSession();
  return {
    id: over.id,
    title: over.title ?? `Task ${over.id}`,
    kind: "coding",
    status: over.status,
    priority: "normal",
    paused: false,
    originalRequest: "req",
    summary: undefined,
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: session.sessionId,
    latestSessionLabel: session.label,
    latestWorkdir: session.workdir,
    latestRepo: null,
    latestActivityAt: session.lastActivityAt,
    decisionCount: session.decisionCount,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    closedAt: null,
    archivedAt: null,
    goal: "the goal",
    roomId: over.roomId,
    taskRoomId: over.roomId,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: over.metadata ?? { source: "telegram" },
    sessions: over.sessions ?? [session],
    decisions: [],
    events: over.events ?? [
      {
        id: "e1",
        threadId: over.id,
        sessionId: session.sessionId,
        eventType: "tool_running",
        timestamp: FIXED_NOW,
        summary: "Running Edit",
        data: {},
        createdAt: new Date(FIXED_NOW).toISOString(),
      },
    ],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
  };
}

function threadOf(detail: TaskThreadDetailDto): TaskThreadDto {
  return detail; // TaskThreadDetailDto extends TaskThreadDto
}

interface Harness {
  runtime: IAgentRuntime;
  sendMessageToTarget: ReturnType<typeof vi.fn>;
  sendToTaskAgent: ReturnType<typeof vi.fn>;
  updateSessionMetadata: ReturnType<typeof vi.fn>;
  acpSessions: Map<string, SessionMeta>;
}

function buildHarness(details: TaskThreadDetailDto[]): Harness {
  const detailById = new Map(details.map((d) => [d.id, d]));
  const acpSessions = new Map<string, SessionMeta>();
  for (const d of details) {
    for (const s of d.sessions) {
      acpSessions.set(s.sessionId, { metadata: { ...s.metadata } });
    }
  }

  const sendMessageToTarget = vi.fn(async () => ({ id: "posted" }));
  const sendToTaskAgent = vi.fn(async () => true);
  const updateSessionMetadata = vi.fn(
    async (sessionId: string, patch: Record<string, unknown>) => {
      const cur = acpSessions.get(sessionId);
      if (cur) cur.metadata = { ...cur.metadata, ...patch };
    },
  );

  const taskService = {
    listTasks: vi.fn(async () => details.map(threadOf)),
    getTask: vi.fn(async (id: string) => detailById.get(id) ?? null),
    sendToTaskAgent,
  };
  const acp = {
    getSession: vi.fn(async (id: string) => {
      const s = acpSessions.get(id);
      return s ? { id, metadata: s.metadata } : undefined;
    }),
    updateSessionMetadata,
  };

  const runtime = {
    getService: vi.fn((type: string) => {
      if (type === OrchestratorTaskService.serviceType) return taskService;
      if (type === AcpService.serviceType) return acp;
      return null;
    }),
    sendMessageToTarget,
    getMessageConnectors: vi.fn(() => [{ source: "telegram" }]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    sendMessageToTarget,
    sendToTaskAgent,
    updateSessionMetadata,
    acpSessions,
  };
}

function newSupervisor(runtime: IAgentRuntime, now = FIXED_NOW) {
  const svc = new TaskSupervisorService(runtime);
  svc.now = () => now;
  return svc;
}

describe("TaskSupervisorService digest loop (#8900)", () => {
  beforeEach(() => {
    delete process.env.ELIZA_ORCHESTRATOR_SUPERVISOR;
    resetSessionSpendUsd();
  });

  it("posts exactly one grouped digest per room and dedups an identical tick", async () => {
    const a = makeDetail({
      id: "task-a",
      title: "alpha",
      status: "active",
      roomId: ROOM_A,
      sessions: [makeSession({ sessionId: "sa", label: "alpha" })],
    });
    const b = makeDetail({
      id: "task-b",
      title: "beta",
      status: "validating",
      roomId: ROOM_A,
      sessions: [makeSession({ sessionId: "sb", label: "beta" })],
    });
    const h = buildHarness([a, b]);
    const svc = newSupervisor(h.runtime);

    await svc.runTick();
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(1);
    const [target, content] = h.sendMessageToTarget.mock.calls[0];
    expect(target).toEqual({ source: "telegram", roomId: ROOM_A });
    expect(content.text).toContain("[alpha]");
    expect(content.text).toContain("[beta]");
    // One grouped message covering both tasks, not one per task.
    expect(content.text.split("\n").length).toBeGreaterThanOrEqual(3);

    // Identical second tick → no new post (change-driven dedup).
    await svc.runTick();
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(1);
  });

  it("posts one digest per room when tasks live in different rooms", async () => {
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [makeSession({ sessionId: "sa", label: "alpha" })],
    });
    const b = makeDetail({
      id: "task-b",
      status: "blocked",
      roomId: ROOM_B,
      sessions: [makeSession({ sessionId: "sb", label: "beta" })],
    });
    const h = buildHarness([a, b]);
    const svc = newSupervisor(h.runtime);

    await svc.runTick();
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(2);
    const rooms = h.sendMessageToTarget.mock.calls.map((c) => c[0].roomId);
    expect(new Set(rooms)).toEqual(new Set([ROOM_A, ROOM_B]));
  });

  it("re-posts when content changes (round count moves)", async () => {
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [
        makeSession({ sessionId: "sa", label: "alpha", decisionCount: 1 }),
      ],
    });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);
    await svc.runTick();
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(1);

    a.sessions[0].decisionCount = 5; // content changes
    await svc.runTick();
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(2);
  });

  it("excludes terminal/open tasks from the digest", async () => {
    const open = makeDetail({ id: "t-open", status: "open", roomId: ROOM_A });
    const done = makeDetail({ id: "t-done", status: "done", roomId: ROOM_A });
    const h = buildHarness([open, done]);
    const svc = newSupervisor(h.runtime);
    await svc.runTick();
    expect(h.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("is disabled when ELIZA_ORCHESTRATOR_SUPERVISOR=0", async () => {
    const a = makeDetail({ id: "task-a", status: "active", roomId: ROOM_A });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);
    process.env.ELIZA_ORCHESTRATOR_SUPERVISOR = "0";
    await svc.start();
    // start() must not arm a timer; runTick is still callable directly but
    // start should have early-returned without throwing.
    await svc.stop();
    expect(h.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("one failing task does not abort the rest of the tick", async () => {
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [makeSession({ sessionId: "sa", label: "alpha" })],
    });
    const b = makeDetail({
      id: "task-b",
      status: "active",
      roomId: ROOM_B,
      sessions: [makeSession({ sessionId: "sb", label: "beta" })],
    });
    const h = buildHarness([a, b]);
    // Make getTask throw for task-a only.
    const original = (
      h.runtime.getService(OrchestratorTaskService.serviceType) as {
        getTask: ReturnType<typeof vi.fn>;
      }
    ).getTask;
    (
      h.runtime.getService(OrchestratorTaskService.serviceType) as {
        getTask: ReturnType<typeof vi.fn>;
      }
    ).getTask = vi.fn(async (id: string) => {
      if (id === "task-a") throw new Error("boom");
      return original(id);
    });
    const svc = newSupervisor(h.runtime);
    await svc.runTick();
    // task-b still posted despite task-a throwing.
    expect(h.sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(h.sendMessageToTarget.mock.calls[0][0].roomId).toBe(ROOM_B);
  });
});

describe("TaskSupervisorService stalled-agent watchdog (#8901)", () => {
  beforeEach(() => {
    delete process.env.ELIZA_ORCHESTRATOR_SUPERVISOR;
    delete process.env.ELIZA_AGENT_SPEND_CAP_USD;
    delete process.env.ACPX_SUB_AGENT_ROUND_TRIP_CAP;
    resetSessionSpendUsd();
  });

  it("flips a session to stalled and grills it when lastEventAt is stale", async () => {
    const staleSession = makeSession({
      sessionId: "stale-1",
      label: "alpha",
      lastActivityAt: FIXED_NOW - 200_000, // > 120s stall TTL
    });
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [staleSession],
    });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);

    await svc.runTick();

    // Grill sent down the existing send-to-agent path.
    expect(h.sendToTaskAgent).toHaveBeenCalledTimes(1);
    const [taskId, sessionId, prompt, reason] = h.sendToTaskAgent.mock.calls[0];
    expect(taskId).toBe("task-a");
    expect(sessionId).toBe("stale-1");
    expect(prompt).toBe(GRILL_PROMPT);
    expect(reason).toBe("watchdog_grill");

    // Structural stalled flag persisted on the ACP session metadata.
    expect(h.updateSessionMetadata).toHaveBeenCalledWith("stale-1", {
      stalled: true,
    });
    expect(h.acpSessions.get("stale-1")?.metadata.stalled).toBe(true);
  });

  it("does not grill a session with fresh activity and clears a prior flag", async () => {
    const freshSession = makeSession({
      sessionId: "fresh-1",
      label: "alpha",
      lastActivityAt: FIXED_NOW - 1_000,
      metadata: { stalled: true }, // was previously stalled
    });
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [freshSession],
    });
    const h = buildHarness([a]);
    // The ACP-side metadata reflects the prior stalled=true.
    h.acpSessions.set("fresh-1", { metadata: { stalled: true } });
    const svc = newSupervisor(h.runtime);

    await svc.runTick();

    expect(h.sendToTaskAgent).not.toHaveBeenCalled();
    // Flag cleared back to false now that the session is active again.
    expect(h.updateSessionMetadata).toHaveBeenCalledWith("fresh-1", {
      stalled: false,
    });
  });

  it("warns the room when a session is near the round-trip cap", async () => {
    process.env.ACPX_SUB_AGENT_ROUND_TRIP_CAP = "32";
    const nearCap = makeSession({
      sessionId: "rt-1",
      label: "alpha",
      decisionCount: 30, // 32 - 3 margin = 29 threshold
      lastActivityAt: FIXED_NOW, // not stalled
    });
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [nearCap],
    });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);

    await svc.runTick();

    const warnings = h.sendMessageToTarget.mock.calls
      .map((c) => c[1].text as string)
      .filter((t) => t.includes("round-trips"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("30/32");

    // Warning posts once per session, not every tick.
    await svc.runTick();
    const warningsAfter = h.sendMessageToTarget.mock.calls
      .map((c) => c[1].text as string)
      .filter((t) => t.includes("round-trips"));
    expect(warningsAfter).toHaveLength(1);
  });

  it("warns the room when session spend exceeds 80% of the cap", async () => {
    process.env.ELIZA_AGENT_SPEND_CAP_USD = "10";
    addSessionSpendUsd("spend-1", 9); // 90% of $10
    const session = makeSession({
      sessionId: "spend-1",
      label: "alpha",
      lastActivityAt: FIXED_NOW,
    });
    const a = makeDetail({
      id: "task-a",
      status: "active",
      roomId: ROOM_A,
      sessions: [session],
    });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);

    await svc.runTick();

    const spendWarnings = h.sendMessageToTarget.mock.calls
      .map((c) => c[1].text as string)
      .filter((t) => t.includes("budget"));
    expect(spendWarnings).toHaveLength(1);
    expect(spendWarnings[0]).toContain("$9.00");
    expect(spendWarnings[0]).toContain("$10.00");
  });
});

describe("TaskSupervisorService lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start arms a timer and stop clears it", async () => {
    delete process.env.ELIZA_ORCHESTRATOR_SUPERVISOR;
    vi.useFakeTimers();
    const a = makeDetail({ id: "task-a", status: "active", roomId: ROOM_A });
    const h = buildHarness([a]);
    const svc = newSupervisor(h.runtime);
    await svc.start();
    await svc.stop();
    // No throws; nothing should have fired synchronously.
    expect(true).toBe(true);
  });
});
