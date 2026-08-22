/**
 * Pins the TASKS cancel authorization contract on a shared runtime:
 *  - cancel rides the same connector role policy as the other gated TASKS
 *    surfaces (an unverified third-party-connector caller is refused before
 *    any session is touched),
 *  - the `all` path is OWNERSHIP-SCOPED — it cancels only sessions stamped
 *    with the requester's room or entity, reports the rest as skipped, and an
 *    unattributable (stamp-less) session fails closed,
 *  - an explicit cross-room sessionId cancel is denied without touching it,
 *  - a failed durable-task interrupt is AUTHORITATIVE: reported via
 *    reportError and surfaced in the result data, never swallowed into a
 *    clean-cancel claim.
 * Harness: real tasksAction handler, stubbed ACP + task services (same
 * pattern as tasks-voice-conversion.test.ts).
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "./tasks.ts";

const ROOM = "55555555-5555-4555-8555-555555555555";
const OTHER_ROOM = "66666666-6666-4666-8666-666666666666";
const AGENT = "00000000-0000-4000-8000-000000000001";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function message(
  text: string,
  opts: { entityId?: string; source?: string } = {},
): Memory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    roomId: ROOM,
    entityId: opts.entityId ?? AGENT,
    content: {
      text,
      metadata: {},
      ...(opts.source ? { source: opts.source } : {}),
    },
  } as unknown as Memory;
}

type FakeSession = {
  id: string;
  sessionId: string;
  agentType: string;
  name?: string;
  workdir: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
  metadata: Record<string, unknown>;
};

function fakeSession(
  id: string,
  label: string,
  metadata: Record<string, unknown> = {},
): FakeSession {
  return {
    id,
    sessionId: id,
    agentType: "codex",
    name: label,
    workdir: "/tmp/cancel-scope-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: { label, ...metadata },
  };
}

function makeRuntime(opts: {
  sessions?: FakeSession[];
  services?: Record<string, unknown>;
}): {
  runtime: IAgentRuntime;
  acp: { stopSession: ReturnType<typeof vi.fn> };
  reportError: ReturnType<typeof vi.fn>;
} {
  const sessions = opts.sessions ?? [];
  const acp = {
    listSessions: vi.fn(async () => sessions),
    getSession: vi.fn(async (id: string) => sessions.find((s) => s.id === id)),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
    sendToSession: vi.fn(async () => undefined),
  };
  const reportError = vi.fn();
  const runtime = {
    agentId: AGENT,
    character: { name: "Cancel scope test" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn(() => undefined),
    reportError,
    // Genuine client-chat: no connector source on the room, so the policy
    // resolves the permissive GUEST default (allowed, NOT role-elevated).
    getRoom: vi.fn(async () => ({ id: ROOM })),
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
        return acp;
      }
      return opts.services?.[type];
    },
  } as unknown as IAgentRuntime;
  return { runtime, acp, reportError };
}

async function run(
  runtime: IAgentRuntime,
  msg: Memory,
  parameters: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; replies: string[] }> {
  const replies: string[] = [];
  const result = (await tasksAction.handler(
    runtime,
    msg,
    undefined as unknown as State,
    { parameters },
    async (content) => {
      if (typeof content.text === "string") replies.push(content.text);
      return [];
    },
  )) as Record<string, unknown>;
  return { result, replies };
}

describe("cancel task-policy gate", () => {
  it("refuses an unverified third-party-connector caller before touching any session", async () => {
    const { runtime, acp } = makeRuntime({
      sessions: [fakeSession("s-1", "site build", { roomId: ROOM })],
    });
    const { result, replies } = await run(
      runtime,
      message("cancel everything", { entityId: USER_A, source: "discord" }),
      { action: "cancel", all: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(result.data).toMatchObject({
      actionName: "TASKS:cancel",
      reason: "access_denied",
      requiredRole: "OWNER",
    });
    // Planner-facing refusal: no callback, and nothing was cancelled.
    expect(replies).toEqual([]);
    expect(acp.stopSession).not.toHaveBeenCalled();
  });
});

describe("cancel all-path ownership scope", () => {
  it("cancels only the requester's room/user sessions; other rooms' and unattributable sessions are skipped receipts", async () => {
    const sessions = [
      fakeSession("s-my-room", "mine by room", { roomId: ROOM }),
      fakeSession("s-my-user", "mine by user", {
        roomId: OTHER_ROOM,
        userId: USER_A,
      }),
      fakeSession("s-other", "someone else's", {
        roomId: OTHER_ROOM,
        userId: USER_B,
      }),
      // No room/user stamps at all: unattributable, fails closed.
      fakeSession("s-legacy", "unstamped"),
    ];
    const { runtime, acp } = makeRuntime({ sessions });
    const { result } = await run(
      runtime,
      message("cancel everything", { entityId: USER_A }),
      { action: "cancel", all: true },
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      canceledCount: 2,
      stoppedSessions: ["s-my-room", "s-my-user"],
      skippedUnauthorized: ["s-other", "s-legacy"],
    });
    expect(acp.stopSession.mock.calls.map((c) => c[0])).toEqual([
      "s-my-room",
      "s-my-user",
    ]);
  });

  it("a role-elevated caller (agent self → OWNER) still cancels every session", async () => {
    const sessions = [
      fakeSession("s-a", "a", { roomId: OTHER_ROOM, userId: USER_B }),
      fakeSession("s-b", "b"),
    ];
    const { runtime, acp } = makeRuntime({ sessions });
    const { result } = await run(runtime, message("cancel everything"), {
      action: "cancel",
      all: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      canceledCount: 2,
      stoppedSessions: ["s-a", "s-b"],
    });
    expect(
      (result.data as Record<string, unknown>).skippedUnauthorized,
    ).toBeUndefined();
    expect(acp.stopSession).toHaveBeenCalledTimes(2);
  });
});

describe("cancel single-target ownership scope", () => {
  it("denies an explicit cross-room sessionId without touching the session", async () => {
    const sessions = [
      fakeSession("s-other", "someone else's", {
        roomId: OTHER_ROOM,
        userId: USER_B,
      }),
    ];
    const { runtime, acp } = makeRuntime({ sessions });
    const { result, replies } = await run(
      runtime,
      message("cancel that", { entityId: USER_A }),
      { action: "cancel", sessionId: "s-other" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(result.data).toMatchObject({
      reason: "session_scope_denied",
      sessionId: "s-other",
    });
    expect(replies).toEqual([]);
    expect(acp.stopSession).not.toHaveBeenCalled();
  });

  it("default targeting (no id, no search) never picks another room's session", async () => {
    const sessions = [
      fakeSession("s-other", "someone else's", {
        roomId: OTHER_ROOM,
        userId: USER_B,
      }),
    ];
    const { runtime, acp } = makeRuntime({ sessions });
    const { result } = await run(
      runtime,
      message("cancel it", { entityId: USER_A }),
      { action: "cancel" },
    );
    // Nothing in the requester's scope: a not-found style miss, not a
    // cross-room kill.
    expect(result.success).toBe(false);
    expect(acp.stopSession).not.toHaveBeenCalled();
  });
});

describe("durable task interruption is authoritative", () => {
  it("a failed interrupt is reported and surfaces in the cancel result — never a silent clean-cancel claim", async () => {
    const taskService = {
      getTaskForSession: vi.fn(async () => ({ id: "task-1" })),
      interruptTask: vi.fn(async () => {
        throw new Error("interrupt db down");
      }),
    };
    const { runtime, acp, reportError } = makeRuntime({
      sessions: [fakeSession("s-1", "widget build", { roomId: ROOM })],
      services: { ORCHESTRATOR_TASK_SERVICE: taskService },
    });
    const { result, replies } = await run(runtime, message("cancel it"), {
      action: "cancel",
    });
    // The session cancel itself still lands...
    expect(result.success).toBe(true);
    expect(acp.stopSession).toHaveBeenCalledWith("s-1");
    // ...but the interrupt failure is a first-class receipt, reported and
    // visible in text — not swallowed.
    expect(result.data).toMatchObject({
      taskInterruptFailures: [{ sessionId: "s-1", error: "interrupt db down" }],
    });
    expect(reportError).toHaveBeenCalledWith(
      "tasks.interruptOwningTask",
      expect.any(Error),
      expect.objectContaining({ sessionId: "s-1" }),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("may resume");
  });

  it("a successful interrupt keeps the clean cancel contract (no failure receipt)", async () => {
    const taskService = {
      getTaskForSession: vi.fn(async () => ({ id: "task-1" })),
      interruptTask: vi.fn(async () => undefined),
    };
    const { runtime } = makeRuntime({
      sessions: [fakeSession("s-1", "widget build", { roomId: ROOM })],
      services: { ORCHESTRATOR_TASK_SERVICE: taskService },
    });
    const { result } = await run(runtime, message("cancel it"), {
      action: "cancel",
    });
    expect(result.success).toBe(true);
    expect(taskService.interruptTask).toHaveBeenCalledWith(
      "task-1",
      "user_cancel",
    );
    expect(
      (result.data as Record<string, unknown>).taskInterruptFailures,
    ).toBeUndefined();
  });
});
