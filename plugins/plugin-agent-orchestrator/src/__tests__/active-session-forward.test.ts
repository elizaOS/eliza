/**
 * Forward-gate matrix for the mid-task MESSAGE_RECEIVED forwarder.
 *
 * The contamination defect: ACP sessions survive their task being parked or
 * archived (keepAliveAfterComplete workers sit `ready`) and keep absorbing
 * live room messages, building the wrong artifact under a dead task's label.
 * The gate consults the durable task record per bound session — dropping
 * archived/failed/done(-without-keep-alive)/verify-parked sessions and
 * administratively-stopped sessions — while question/login parks and
 * gate-failure paths keep forwarding (fail-open). Deterministic harness: the
 * real handler + real interruption decider; only ACP and the task lookup are
 * faked.
 */

import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import {
  createActiveSessionForwardHandler,
  shouldForwardForTask,
} from "../services/active-session-forward.ts";
import { ADMIN_STOP_META_KEY } from "../services/admin-stop-marker.ts";
import type { OrchestratorTaskRecord } from "../services/orchestrator-task-types.ts";
import { SubAgentInbox } from "../services/sub-agent-inbox.ts";
import type { SessionInfo } from "../services/types.ts";

const ROOM = "22222222-2222-4222-8222-222222222222" as const;
const USER = "33333333-3333-4333-8333-333333333333" as const;
const AGENT = "44444444-4444-4444-8444-444444444444" as const;

function makeSession(
  id: string,
  metadata: Record<string, unknown> = {},
): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "opencode",
    workdir: "/tmp/work",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { roomId: ROOM, label: id, ...metadata },
  } as SessionInfo;
}

function makeTask(
  overrides: Partial<OrchestratorTaskRecord>,
): OrchestratorTaskRecord {
  return {
    id: "task-1",
    title: "t",
    goal: "g",
    kind: "coding",
    status: "active",
    priority: "normal",
    originalRequest: "",
    acceptanceCriteria: [],
    paused: false,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
    metadata: {},
    ...overrides,
  } as OrchestratorTaskRecord;
}

interface HarnessOpts {
  sessions: SessionInfo[];
  /** sessionId → task record (or null), or a throwing lookup. */
  tasksBySession?: Record<string, OrchestratorTaskRecord | null>;
  lookupThrows?: boolean;
  /** Omit the task service entirely (fail-open path). */
  noTaskService?: boolean;
}

function harness(opts: HarnessOpts) {
  const sendPrompt = vi.fn(async () => undefined);
  const useModel = vi.fn(async () => '{"action":"ignore","reason":"model"}');
  const warn = vi.fn();
  const acp = {
    listSessions: () => opts.sessions,
    sendPrompt,
    cancelSession: vi.fn(async () => undefined),
  };
  const getTaskForSession = vi.fn(async (sessionId: string) => {
    if (opts.lookupThrows) throw new Error("store offline");
    return opts.tasksBySession?.[sessionId] ?? null;
  });
  const runtime = {
    agentId: AGENT,
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    getSetting: () => undefined,
    useModel,
    reportError: vi.fn(),
    getService: (type: string) => {
      if (type === AcpService.serviceType) return acp;
      if (type === "ORCHESTRATOR_TASK_SERVICE" && !opts.noTaskService) {
        return { getTaskForSession };
      }
      return undefined;
    },
  };
  const handler = createActiveSessionForwardHandler(
    runtime as never,
    new SubAgentInbox(),
  );
  const message = {
    entityId: USER,
    roomId: ROOM,
    content: { text: "please add a footer", source: "test-conn" },
  };
  return { handler, message, sendPrompt, useModel, warn, getTaskForSession };
}

describe("shouldForwardForTask matrix", () => {
  it("drops archived, failed, and archived-flagged tasks", () => {
    expect(shouldForwardForTask(makeTask({ status: "archived" }), {})).toBe(
      false,
    );
    expect(shouldForwardForTask(makeTask({ status: "failed" }), {})).toBe(
      false,
    );
    expect(
      shouldForwardForTask(makeTask({ status: "active", archived: true }), {}),
    ).toBe(false);
  });

  it("drops done without keep-alive; forwards done with the session's keepAliveAfterComplete opt-in", () => {
    expect(shouldForwardForTask(makeTask({ status: "done" }), {})).toBe(false);
    expect(
      shouldForwardForTask(makeTask({ status: "done" }), {
        keepAliveAfterComplete: true,
      }),
    ).toBe(true);
  });

  it("drops verify parks but keeps question/login parks forwarding", () => {
    expect(
      shouldForwardForTask(
        makeTask({
          status: "waiting_on_user",
          metadata: { verifyParkedAt: "2026-08-17T00:00:00Z" },
        }),
        {},
      ),
    ).toBe(false);
    expect(
      shouldForwardForTask(
        makeTask({
          status: "waiting_on_user",
          metadata: { verifyEscalationNotifiedAt: "2026-08-17T00:00:00Z" },
        }),
        {},
      ),
    ).toBe(false);
    // Question/login park: waiting_on_user with NO verify stamp — the user's
    // answer must still reach the blocked session.
    expect(
      shouldForwardForTask(makeTask({ status: "waiting_on_user" }), {}),
    ).toBe(true);
  });

  it("drops a pre-stamp verify park via its persisted autoVerifyAttempts counter", () => {
    // Tasks parked BEFORE the verifyParkedAt stamp deployed carry neither new
    // stamp, but BOTH park branches persisted autoVerifyAttempts >= 1 before
    // parking — that counter is the legacy discriminator, so old verify-parked
    // sessions stop absorbing live room messages too.
    expect(
      shouldForwardForTask(
        makeTask({
          status: "waiting_on_user",
          metadata: { autoVerifyAttempts: 2 },
        }),
        {},
      ),
    ).toBe(false);
    // A login/question park never bumps the counter: 0 or absent keeps
    // forwarding (the user's answer must reach the blocked session).
    expect(
      shouldForwardForTask(
        makeTask({
          status: "waiting_on_user",
          metadata: { autoVerifyAttempts: 0 },
        }),
        {},
      ),
    ).toBe(true);
  });

  it("forwards open/active/blocked/validating/interrupted and no-record sessions", () => {
    for (const status of [
      "open",
      "active",
      "blocked",
      "validating",
      "interrupted",
    ] as const) {
      expect(shouldForwardForTask(makeTask({ status }), {})).toBe(true);
    }
    expect(shouldForwardForTask(null, {})).toBe(true);
  });
});

describe("forward handler gating", () => {
  it("forwards a live session with an active task", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1")],
      tasksBySession: { s1: makeTask({ status: "active" }) },
    });
    await handler({ message: message as never });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("drops a verify-parked waiting_on_user session", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1")],
      tasksBySession: {
        s1: makeTask({
          status: "waiting_on_user",
          metadata: { verifyParkedAt: "2026-08-17T00:00:00Z" },
        }),
      },
    });
    await handler({ message: message as never });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("drops an archived-task session (the contamination survivor)", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1", { keepAliveAfterComplete: true })],
      tasksBySession: {
        s1: makeTask({ status: "archived", archived: true }),
      },
    });
    await handler({ message: message as never });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("drops an administratively-stopped session even with a live-looking task (belt)", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1", { [ADMIN_STOP_META_KEY]: "user_stop" })],
      tasksBySession: { s1: makeTask({ status: "active" }) },
    });
    await handler({ message: message as never });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("forwards when the session has no durable task record", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1")],
      tasksBySession: { s1: null },
    });
    await handler({ message: message as never });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("forwards when the task service is absent entirely", async () => {
    const { handler, message, sendPrompt } = harness({
      sessions: [makeSession("s1")],
      noTaskService: true,
    });
    await handler({ message: message as never });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("forwards with a warn when getTaskForSession throws (fail-open)", async () => {
    const { handler, message, sendPrompt, warn } = harness({
      sessions: [makeSession("s1")],
      lookupThrows: true,
    });
    await handler({ message: message as never });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("computes multiParty from the POST-gate list", async () => {
    // Two sessions bound to the room; one is gated out (archived task). The
    // survivor must be treated as SOLO: the idle+solo+dedicated fast path
    // never calls the model classifier, and the unaddressed line delivers.
    // Pre-gate multiParty (2) would force the model call and an "ignore".
    const { handler, message, sendPrompt, useModel } = harness({
      sessions: [makeSession("s1"), makeSession("s2")],
      tasksBySession: {
        s1: makeTask({ status: "active" }),
        s2: makeTask({ id: "task-2", status: "archived", archived: true }),
      },
    });
    await handler({ message: message as never });
    expect(useModel).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});
