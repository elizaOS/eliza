/**
 * Integration test for the rate-limit / capacity FAILOVER RESUME path in the
 * SubAgentRouter.
 *
 * When a coding sub-agent dies with a pooled-account rate-limit failure and a
 * healthy sibling account remains, the router fails over and respawns IN THE
 * SAME WORKTREE. This test verifies the resume-continuity behavior this lane
 * adds on top of that existing failover:
 *   1. the successor is spawned with a RESUME PREAMBLE (continue, not restart)
 *      wrapping the original task;
 *   2. the successor's metadata carries the typed `resumeContext` marker;
 *   3. the successor reuses the predecessor's workdir (branch + uncommitted
 *      work preserved on disk);
 *   4. a `account_failover_resumed` session event is emitted on the mapped predecessor
 *      so the UI can show "rate-limited, resumable".
 *
 * Deterministic: a minimal in-memory coding-account bridge is installed on the
 * globalThis symbol so `hasHealthyPooledAccount` / `reportCodingAccountFailure`
 * resolve without a live pool; no model, no subprocess, no I/O.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/config-env.js", () => ({
  readConfigEnvKey: (key: string) => process.env[key],
}));

// Compute the coding-agent selector bridge slot key via Symbol.for so this
// test does not depend on the built @elizaos/core re-exporting the symbol
// constant (a stale symlinked node_modules build can lag the source). The key
// string is the bridge contract
// (packages/core/src/account-pool-bridge.ts); Symbol.for resolves the SAME
// registered symbol the source's bridgeSlot() reads/writes.
const BRIDGE_SYMBOL = Symbol.for("eliza.account-pool.coding-agent.v1");

import {
  RESUME_CONTEXT_METADATA_KEY,
  readResumeContext,
} from "../../src/services/resume-context.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-1111-1111-1111-111111111111";
const WORLD = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PARENT_MSG = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";
const WORKDIR = "/tmp/failover-resume-repo";

function installHealthyBridge(agentType: string): {
  markRateLimited: ReturnType<typeof vi.fn>;
  markNeedsReauth: ReturnType<typeof vi.fn>;
} {
  const markRateLimited = vi.fn(async () => undefined);
  const markNeedsReauth = vi.fn(async () => undefined);
  const bridge = {
    describe: () => ({
      [agentType.toLowerCase()]: [
        {
          providerId: "anthropic-subscription",
          total: 2,
          enabled: 2,
          healthy: 1,
        },
      ],
    }),
    select: async () => null,
    markRateLimited,
    markNeedsReauth,
    recordUsage: async () => undefined,
  };
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
  return { markRateLimited, markNeedsReauth };
}

function clearBridge() {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

interface CapturedHandler {
  fn?: (sessionId: string, event: string, data: unknown) => void;
}

function makeAcp(session: SessionInfo, emitError?: Error, sessionOutput = "") {
  const captured: CapturedHandler = {};
  const emitSessionEvent = vi.fn(() => {
    if (emitError) throw emitError;
  });
  const spawnSession = vi.fn(async (o: { workdir?: string }) => ({
    sessionId: "resume-session-id",
    id: "resume-session-id",
    name: "resume",
    agentType: session.agentType,
    workdir: o.workdir ?? WORKDIR,
    status: "ready",
  }));
  const service = {
    onSessionEvent: vi.fn((handler: typeof captured.fn) => {
      captured.fn = handler;
      return () => {
        captured.fn = undefined;
      };
    }),
    stopSession: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) =>
      id === session.id ? session : null,
    ),
    listSessions: vi.fn(async () => [session]),
    updateSessionMetadata: vi.fn(async () => {}),
    getChangedPaths: vi.fn(() => [] as string[]),
    getSessionOutput: vi.fn(async () => sessionOutput),
    sendToSession: vi.fn(async () => ({})),
    spawnSession,
    emitSessionEvent,
  };
  return {
    service,
    spawnSession,
    emitSessionEvent,
    emit(sessionId: string, event: string, data: unknown) {
      captured.fn?.(sessionId, event, data);
    },
  };
}

function makeRuntime(acpService: unknown) {
  const handleMessage = vi.fn(async () => ({}));
  return {
    runtime: {
      agentId: "00000000-0000-0000-0000-000000000001",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => acpService ?? null),
      getSetting: vi.fn(() => undefined),
      createMemory: vi.fn(async () => undefined),
      createEntity: vi.fn(async () => true),
      addParticipant: vi.fn(async () => true),
      getEntitiesForRoom: vi.fn(async () => []),
      deleteParticipants: vi.fn(async () => true),
      reportError: vi.fn(),
      emitEvent: vi.fn(async () => undefined),
      sendMessageToTarget: vi.fn(async () => ({})),
      messageService: { handleMessage },
    } as never,
    handleMessage,
  };
}

function makeSession(agentType: string): SessionInfo {
  return {
    id: SESSION_ID,
    name: "failover-task",
    agentType: agentType as SessionInfo["agentType"],
    workdir: WORKDIR,
    status: "ready",
    approvalPreset: "standard",
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    lastActivityAt: new Date("2026-07-11T00:00:00.000Z"),
    metadata: {
      label: "failover-task",
      roomId: ROOM,
      worldId: WORLD,
      userId: USER,
      messageId: PARENT_MSG,
      source: "telegram",
      initialTask: "Implement the widget and add tests",
      account: {
        providerId: "anthropic-subscription",
        accountId: "acct-1",
        label: "Work",
        source: "oauth",
        strategy: "least-used",
      },
    },
  };
}

afterEach(() => {
  clearBridge();
  vi.restoreAllMocks();
});

describe("SubAgentRouter — rate-limit failover resume", () => {
  it("resumes the successor with a preamble, marker, same workdir, and event", async () => {
    const marks = installHealthyBridge("claude");
    const session = makeSession("claude");
    const acp = makeAcp(session);
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    // A pooled-account rate-limit failure with a healthy sibling → failover
    // resume.
    acp.emit(SESSION_ID, "error", {
      message: "Error 429: rate limit exceeded — too many requests",
    });
    await new Promise((r) => setTimeout(r, 300));

    // 1. Dud account marked rate-limited on the pool.
    expect(marks.markRateLimited).toHaveBeenCalledTimes(1);

    // 2. A successor was spawned exactly once, in the SAME worktree.
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    const arg = acp.spawnSession.mock.calls[0]?.[0] as {
      workdir?: string;
      initialTask?: string;
      metadata?: Record<string, unknown>;
    };
    expect(arg?.workdir).toBe(WORKDIR);

    // 3. The successor's instruction carries the resume preamble AND the
    //    original task (continue, not restart).
    expect(arg?.initialTask).toContain("RESUMING AFTER FAILOVER");
    expect(arg?.initialTask).toMatch(/Do NOT start over/i);
    expect(arg?.initialTask).toContain("git status");
    expect(arg?.initialTask).toContain("Implement the widget and add tests");

    // 4. The successor carries the typed resume marker; the UNWRAPPED original
    //    task is preserved on metadata for lineage/ref-text keying.
    const marker = readResumeContext(
      arg?.metadata?.[RESUME_CONTEXT_METADATA_KEY],
    );
    expect(marker?.kind).toBe("rate-limit-failover");
    expect(marker?.reason).toBe("rate-limited");
    expect(marker?.fromSessionId).toBe(SESSION_ID);
    expect(marker?.workdir).toBe(WORKDIR);
    expect(marker?.authReason).toBeUndefined();
    expect(arg?.metadata?.initialTask).toBe(
      "Implement the widget and add tests",
    );
    expect(arg?.metadata?.retryOfSessionId).toBe(SESSION_ID);

    // 5. The resumable failover is surfaced through the mapped predecessor.
    const resumeEvt = acp.emitSessionEvent.mock.calls.find(
      (c) => c[1] === "account_failover_resumed",
    );
    expect(resumeEvt).toBeDefined();
    expect(resumeEvt?.[0]).toBe(SESSION_ID);
    expect(resumeEvt?.[2]).toMatchObject({
      successorSessionId: "resume-session-id",
      resumable: true,
      resumeReason: "rate-limited",
      resumeFromSessionId: SESSION_ID,
      workdir: WORKDIR,
    });
  });

  it("does NOT resume (no failover) when no healthy account remains", async () => {
    // Bridge with zero healthy accounts → hasHealthyPooledAccount false.
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      describe: () => ({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 1,
            enabled: 1,
            healthy: 0,
          },
        ],
      }),
      select: async () => null,
      markRateLimited: vi.fn(async () => undefined),
      markNeedsReauth: vi.fn(async () => undefined),
      recordUsage: async () => undefined,
    };
    const session = makeSession("claude");
    const acp = makeAcp(session);
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "Error 429: rate limit exceeded",
    });
    await new Promise((r) => setTimeout(r, 300));

    // Pool still marked, but no failover respawn (whole pool exhausted).
    expect(acp.spawnSession).not.toHaveBeenCalled();
    expect(
      acp.emitSessionEvent.mock.calls.some(
        (c) => c[1] === "account_failover_resumed",
      ),
    ).toBe(false);
  });

  it("does NOT stamp a resume marker for a non-account (generic) crash", async () => {
    installHealthyBridge("claude");
    const session = makeSession("claude");
    const acp = makeAcp(session);
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    // A generic error that classifyAccountFailure does NOT flag as an account
    // failure → no account-failover resume path.
    acp.emit(SESSION_ID, "error", {
      message: "TypeError: cannot read property 'x' of undefined",
    });
    await new Promise((r) => setTimeout(r, 300));

    // No resume event; if any respawn happened it would be the generic
    // state-lost path, which never carries the resume marker.
    expect(
      acp.emitSessionEvent.mock.calls.some(
        (c) => c[1] === "account_failover_resumed",
      ),
    ).toBe(false);
    for (const call of acp.spawnSession.mock.calls) {
      const meta = (call[0] as { metadata?: Record<string, unknown> })
        ?.metadata;
      expect(meta?.[RESUME_CONTEXT_METADATA_KEY]).toBeUndefined();
    }
  });

  it("reports a resume-event telemetry failure without undoing failover", async () => {
    installHealthyBridge("claude");
    const session = makeSession("claude");
    const emitError = new Error("subscriber failed");
    const acp = makeAcp(session, emitError);
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "Error 429: rate limit exceeded",
    });
    await new Promise((r) => setTimeout(r, 300));

    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "resume-session-id" }),
      "account failover resume event emit failed",
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "SubAgentRouter.emitAccountFailoverResumed",
      emitError,
      { sessionId: "resume-session-id" },
    );
  });

  it("uses recorded predecessor output as the authoritative progress summary", async () => {
    installHealthyBridge("claude");
    const session = makeSession("claude");
    const acp = makeAcp(
      session,
      undefined,
      "Edited src/widget.ts\nRan focused tests",
    );
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "Error 429: rate limit exceeded",
      summary: "stale error payload summary",
    });
    await new Promise((r) => setTimeout(r, 300));

    expect(acp.service.getSessionOutput).toHaveBeenCalledWith(SESSION_ID, 120);
    const arg = acp.spawnSession.mock.calls[0]?.[0] as {
      initialTask?: string;
      metadata?: Record<string, unknown>;
    };
    expect(arg.initialTask).toContain("Edited src/widget.ts");
    expect(arg.initialTask).toContain("Ran focused tests");
    expect(arg.initialTask).not.toContain("stale error payload summary");
    const marker = readResumeContext(
      arg.metadata?.[RESUME_CONTEXT_METADATA_KEY],
    );
    expect(marker?.lastProgress).toBe(
      "Edited src/widget.ts\nRan focused tests",
    );
  });

  it("keeps token_expired as trigger metadata on the successful resume outcome", async () => {
    const marks = installHealthyBridge("claude");
    const session = makeSession("claude");
    const acp = makeAcp(session);
    const { runtime } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "Claude access token has expired",
    });
    await new Promise((r) => setTimeout(r, 300));

    expect(marks.markNeedsReauth).toHaveBeenCalledTimes(1);
    const arg = acp.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    const marker = readResumeContext(
      arg.metadata?.[RESUME_CONTEXT_METADATA_KEY],
    );
    expect(marker?.reason).toBe("needs-reauth");
    expect(marker?.authReason).toBe("token_expired");
    const resumeEvt = acp.emitSessionEvent.mock.calls.find(
      (c) => c[1] === "account_failover_resumed",
    );
    expect(resumeEvt?.[2]).toMatchObject({
      resumable: true,
      resumeReason: "needs-reauth",
      authReason: "token_expired",
      resumeFromSessionId: SESSION_ID,
    });
  });
});

function makeTaskAcp() {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const service = {
    onSessionEvent: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => {
        handler = undefined;
      };
    }),
    getSession: vi.fn(async () => null),
    getChangedPaths: vi.fn(() => [] as string[]),
  };
  return {
    service,
    emit(sessionId: string, event: string, data: unknown) {
      handler?.(sessionId, event, data);
    },
  };
}

function makeTaskRuntime(acpService: unknown) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn(() => acpService),
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
  } as never;
}

async function flushEventBridge() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForTaskStatus(
  store: OrchestratorTaskStore,
  taskId: string,
  status: string,
) {
  for (let i = 0; i < 40; i++) {
    const doc = await store.getTask(taskId);
    if (doc?.task.status === status) return doc;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.getTask(taskId);
}

function makeStoredSession(
  taskId: string,
  sessionId: string,
  patch: Partial<OrchestratorTaskSession> = {},
): OrchestratorTaskSession {
  const now = Date.now();
  const iso = new Date("2026-07-11T00:00:00.000Z").toISOString();
  return {
    id: `${sessionId}-row`,
    taskId,
    sessionId,
    framework: "claude",
    label: "worker",
    originalTask: "Implement the widget and add tests",
    workdir: WORKDIR,
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: iso,
    updatedAt: iso,
    ...patch,
  };
}

describe("OrchestratorTaskService — ACP event bridge", () => {
  const previousAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;

  afterEach(() => {
    if (previousAutoVerify === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    } else {
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = previousAutoVerify;
    }
  });

  it("records canonical progress, completion, and late-error outcomes", async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    const acp = makeTaskAcp();
    const runtime = makeTaskRuntime(acp.service);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();

    const created = await store.createTask({
      title: "Widget",
      goal: "Implement the widget and add tests",
      originalRequest: "Please implement the widget.",
      acceptanceCriteria: ["Focused tests pass"],
    });
    await store.addSession(
      makeStoredSession(created.task.id, "task-session", {
        metadata: { lastChangeSet: { changedFiles: "malformed" } },
      }),
    );

    acp.emit("task-session", "ready", {});
    await flushEventBridge();
    expect((await store.getTask(created.task.id))?.task.status).toBe("active");

    acp.emit("task-session", "plan", {
      entries: [{ text: "Add tests", status: "in_progress" }],
    });
    acp.emit("task-session", "message", { text: "Implemented widget tests." });
    acp.emit("task-session", "task_complete", {
      response: "Done. Tests pass.",
    });

    const completed = await waitForTaskStatus(
      store,
      created.task.id,
      "validating",
    );
    expect(completed?.task.status).toBe("validating");
    expect(completed?.task.currentPlan).toEqual({
      entries: [{ text: "Add tests", status: "in_progress" }],
    });
    expect(completed?.messages.map((message) => message.content)).toContain(
      "Implemented widget tests.",
    );
    expect(
      completed?.events.map((event) => [event.eventType, event.summary]),
    ).toEqual(
      expect.arrayContaining([
        ["ready", "Sub-agent ready"],
        ["plan", "Updated plan — 1 item"],
        ["task_complete", "Sub-agent reported completion (pending validation)"],
      ]),
    );
    expect(
      completed?.sessions.find(
        (session) => session.sessionId === "task-session",
      ),
    ).toMatchObject({
      status: "completed",
      taskDelivered: true,
      completionSummary: "Done. Tests pass.",
    });

    acp.emit("task-session", "error", {
      message: "state dropped after completion",
    });
    await flushEventBridge();
    const afterLateError = await store.getTask(created.task.id);
    expect(afterLateError?.task.status).toBe("validating");
    expect(
      afterLateError?.sessions.find(
        (session) => session.sessionId === "task-session",
      )?.status,
    ).toBe("completed");

    await service.stop();
  });

  it("routes unrecoverable and account-failover errors through distinct task outcomes", async () => {
    const marks = installHealthyBridge("claude");
    const acp = makeTaskAcp();
    const runtime = makeTaskRuntime(acp.service);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();

    const plain = await store.createTask({
      title: "Plain crash",
      goal: "Crash plainly",
      acceptanceCriteria: ["No crash"],
    });
    await store.addSession(makeStoredSession(plain.task.id, "plain-session"));
    acp.emit("plain-session", "error", { message: "TypeError: boom" });
    await flushEventBridge();
    const plainDoc = await store.getTask(plain.task.id);
    expect(plainDoc?.task.status).toBe("failed");
    expect(plainDoc?.events.map((event) => event.eventType)).toContain(
      "task_failed",
    );

    const pooled = await store.createTask({
      title: "Pooled failover",
      goal: "Continue after rate limit",
      acceptanceCriteria: ["Retry on healthy account"],
    });
    await store.addSession(
      makeStoredSession(pooled.task.id, "pooled-session", {
        accountProviderId: "anthropic-subscription",
        accountId: "acct-1",
        accountLabel: "Work",
      }),
    );
    acp.emit("pooled-session", "ready", {});
    await flushEventBridge();
    acp.emit("pooled-session", "error", {
      message: "429 rate limit exceeded",
    });
    await flushEventBridge();
    const pooledDoc = await store.getTask(pooled.task.id);
    expect(pooledDoc?.task.status).toBe("active");
    expect(pooledDoc?.events.map((event) => event.eventType)).toContain(
      "session_error_retrying",
    );
    expect(marks.markRateLimited).toHaveBeenCalledTimes(1);
    expect(
      pooledDoc?.sessions.find(
        (session) => session.sessionId === "pooled-session",
      ),
    ).toMatchObject({ status: "errored", retryCount: 1 });

    await service.stop();
  });
});
