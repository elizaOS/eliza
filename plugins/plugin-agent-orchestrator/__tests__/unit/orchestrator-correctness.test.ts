/**
 * Orchestrator correctness suite (#9960) — the four sub-agent / room / task /
 * multi-task flows, asserted deterministically against a fake transport.
 *
 * The acceptance criterion asks for four correctness tests: (1) spawn → route →
 * task_complete → evaluator summary; (2) a room message routed to the active
 * sub-agent via the interruption decider; (3) the multi-task supervisor digest
 * across rooms; (4) concurrent multi-task isolation. Scenarios 2 and 3 already
 * have exhaustive dedicated suites (`active-session-forward.test.ts`,
 * `interruption-decider.test.ts`, `task-supervisor.test.ts`) — this file
 * exercises all four in one place and adds the integration coverage the
 * piecewise unit tests don't: the full spawn→route→evaluate chain (1) and
 * concurrent isolation with independent round-trip accounting + no cross-talk
 * between two tasks/accounts/sessions (4).
 */

import type {
  Content,
  HandlerCallback,
  Memory,
  MessageHandlerResult,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { subAgentCompletionResponseEvaluator } from "../../src/evaluators/sub-agent-completion.js";
import { decideInterruption } from "../../src/services/interruption-decider.js";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import {
  composeRoomDigest,
  runSupervisorTick,
  type SupervisorTaskView,
} from "../../src/services/task-supervisor-service.js";
import type { SessionInfo } from "../../src/services/types.js";

const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "ffffffff-1111-2222-3333-444444444444";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-06-29T12:00:00.000Z");
  return {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    name: "demo-task",
    agentType: "codex",
    workdir: "/tmp/wf",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label: "demo",
      roomId: "11111111-2222-3333-4444-555555555555",
      worldId: WORLD,
      userId: USER,
      messageId: "99999999-8888-7777-6666-555555555555",
      source: "telegram",
    },
    ...overrides,
  };
}

/** Fake ACP transport: register the router's event handler and emit into it. */
function makeAcp(sessions: SessionInfo[]) {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const stopSession = vi.fn(async () => undefined);
  const service = {
    onSessionEvent: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => {
        handler = undefined;
      };
    }),
    getSession: vi.fn(async (id: string) => byId.get(id) ?? null),
    listSessions: vi.fn(async () => [...byId.values()]),
    updateSessionMetadata: vi.fn(async () => undefined),
    getChangedPaths: vi.fn(() => [] as string[]),
    stopSession,
    sendToSession: vi.fn(async () => ({})),
  };
  return {
    service,
    stopSession,
    emit(id: string, event: string, data: unknown) {
      handler?.(id, event, data);
    },
  };
}

function makeRuntime(acp: unknown, setting?: Record<string, string>) {
  const posts: Memory[] = [];
  const handleMessage = vi.fn(
    async (_rt: unknown, memory: Memory, _cb?: HandlerCallback) => {
      posts.push(memory);
      return {};
    },
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: vi.fn(() => acp),
    getSetting: vi.fn((k: string) => setting?.[k]),
    createMemory: vi.fn(async () => undefined),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
    sendMessageToTarget: vi.fn(async (_t: unknown, content: Content) => ({
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      content,
    })),
    messageService: { handleMessage },
  } as never;
  return { runtime, posts };
}

const tick = () => new Promise((r) => setImmediate(r));
const sessionIdOf = (m: Memory) =>
  (m.content?.metadata as Record<string, unknown> | undefined)
    ?.subAgentSessionId;

describe("orchestrator correctness (#9960)", () => {
  // --- Scenario 1: spawn → route → task_complete → evaluator summary ---
  it("routes a task_complete into a synthetic memory the evaluator turns into a reply", async () => {
    const session = makeSession();
    const acp = makeAcp([session]);
    const { runtime, posts } = makeRuntime(acp.service);
    await SubAgentRouter.start(runtime);

    acp.emit(session.id, "task_complete", { response: "$1,708.31" });
    await tick();

    // The router posted exactly one synthetic inbound for the origin.
    expect(posts).toHaveLength(1);
    const posted = posts[0];
    const meta = posted.content?.metadata as Record<string, unknown>;
    expect(meta.subAgentEvent).toBe("task_complete");
    expect(meta.subAgentSessionId).toBe(session.id);
    expect(posted.content?.text).toContain("$1,708.31");

    // Feed that exact router-posted memory into the completion evaluator, which
    // strips the planner-only directive header and relays the answer.
    const messageHandler: MessageHandlerResult = {
      processMessage: "RESPOND",
      thought: "",
      plan: {
        contexts: ["general"],
        reply: "Working on it.",
        requiresTool: true,
      },
    };
    const context: ResponseHandlerEvaluatorContext = {
      runtime: {} as never,
      message: posted,
      state: {} as never,
      messageHandler,
      availableContexts: [{ id: SIMPLE_CONTEXT_ID, description: "simple" }],
    };
    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    const result = await subAgentCompletionResponseEvaluator.evaluate(context);
    expect(result?.reply).toBe("$1,708.31");
    expect(result?.reply).not.toContain("do NOT start another sub-agent");
  });

  // --- Scenario 2: room message → interruption decider (deliver/queue/interrupt/ignore) ---
  it("decides each interruption action for a room message to an active sub-agent", () => {
    // Idle agent → deliver now.
    expect(
      decideInterruption({
        text: "add a footer",
        agentType: "codex",
        sessionBusy: false,
      }).action,
    ).toBe("deliver");
    // Busy agent, normal follow-up → queue until the turn ends.
    expect(
      decideInterruption({
        text: "also tweak the colors",
        agentType: "codex",
        sessionBusy: true,
      }).action,
    ).toBe("queue");
    // Busy agent, explicit stop → interrupt.
    expect(
      decideInterruption({
        text: "stop",
        agentType: "codex",
        sessionBusy: true,
      }).action,
    ).toBe("interrupt");
    // Crowded room, ambient chatter not addressed to this agent → ignore.
    expect(
      decideInterruption({
        text: "lol nice",
        agentType: "codex",
        sessionBusy: true,
        multiParty: true,
      }).action,
    ).toBe("ignore");
  });

  // --- Scenario 3: multi-task supervisor digest across rooms ---
  it("posts one digest per origin room and dedupes an unchanged second tick", async () => {
    const views: SupervisorTaskView[] = [
      {
        id: "t1",
        label: "frontend",
        status: "active",
        activeSessions: 1,
        sessionLabel: "codex · acct-a",
        origin: { roomId: "room-a", source: "telegram" },
      },
      {
        id: "t2",
        label: "backend",
        status: "validating",
        activeSessions: 1,
        sessionLabel: "claude · acct-b",
        origin: { roomId: "room-b", source: "telegram" },
      },
    ];
    const sent: Array<{ roomId: string; text: string }> = [];
    const send = async (
      target: { source: string; roomId: string },
      content: Content,
    ) => {
      sent.push({ roomId: target.roomId, text: String(content.text) });
      return undefined;
    };
    const seen = new Map<string, string>();

    const first = await runSupervisorTick(views, send as never, seen);
    expect(first.posted.sort()).toEqual(["room-a", "room-b"]);
    expect(sent).toHaveLength(2);
    // Each room got only its own task — no cross-talk.
    expect(sent.find((s) => s.roomId === "room-a")?.text).toContain("frontend");
    expect(sent.find((s) => s.roomId === "room-a")?.text).not.toContain(
      "backend",
    );

    const second = await runSupervisorTick(views, send as never, seen);
    expect(second.posted).toEqual([]);
    expect(second.skipped.sort()).toEqual(["room-a", "room-b"]);
    expect(sent).toHaveLength(2); // no re-post on steady state

    // Digest is deterministic for a fixed view set.
    expect(composeRoomDigest([views[0]])).toContain("frontend");
  });

  // --- Scenario 4: concurrent multi-task isolation (2 tasks, 2 accounts, 2 sessions) ---
  it("keeps two concurrent tasks isolated with independent round-trip accounting", async () => {
    const a = makeSession({
      id: "aaaaaaa1-89ab-cdef-0123-456789abcdef",
      agentType: "claude", // stand-in for account A
      metadata: {
        label: "task-a",
        roomId: "a0000000-2222-3333-4444-555555555555",
        worldId: WORLD,
        userId: USER,
        messageId: "a1111111-8888-7777-6666-555555555555",
        source: "telegram",
      },
    });
    const b = makeSession({
      id: "bbbbbbb2-89ab-cdef-0123-456789abcdef",
      agentType: "codex", // stand-in for account B
      metadata: {
        label: "task-b",
        roomId: "b0000000-2222-3333-4444-555555555555",
        worldId: WORLD,
        userId: USER,
        messageId: "b1111111-8888-7777-6666-555555555555",
        source: "telegram",
      },
    });
    const acp = makeAcp([a, b]);
    // Cap of 1: the 2nd counted round-trip for a session force-stops IT only.
    const { runtime, posts } = makeRuntime(acp.service, {
      ACPX_SUB_AGENT_ROUND_TRIP_CAP: "1",
    });
    await SubAgentRouter.start(runtime);

    // Interleave distinct completions from both sessions.
    acp.emit(a.id, "task_complete", { response: "A first" });
    await tick();
    acp.emit(b.id, "task_complete", { response: "B first" });
    await tick();
    acp.emit(a.id, "task_complete", { response: "A second (over cap)" });
    await tick();

    // No cross-talk: every post for A is bound to room A, every post for B to
    // room B, and each carries its own session id.
    const aPosts = posts.filter((m) => sessionIdOf(m) === a.id);
    const bPosts = posts.filter((m) => sessionIdOf(m) === b.id);
    expect(aPosts.length).toBe(2);
    expect(bPosts.length).toBe(1);
    for (const m of aPosts) expect(m.roomId).toBe(a.metadata?.roomId);
    for (const m of bPosts) expect(m.roomId).toBe(b.metadata?.roomId);

    // Independent accounting: only A crossed its cap and was force-stopped.
    expect(acp.stopSession).toHaveBeenCalledWith(a.id);
    expect(acp.stopSession).not.toHaveBeenCalledWith(b.id);
    const aCapPost = aPosts.find(
      (m) =>
        (m.content?.metadata as Record<string, unknown>)
          ?.subAgentCapExceeded === true,
    );
    expect(aCapPost, "A's over-cap completion is force-stopped").toBeTruthy();
  });
});
