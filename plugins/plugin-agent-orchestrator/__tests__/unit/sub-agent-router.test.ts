import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Content, HandlerCallback, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHostResolver } from "../../src/services/ssrf-guard.js";
import {
  extractShortToolDeliverable,
  extractSubResources,
  normalizeUrlsInText,
  redactLoopbackUrls,
  SubAgentRouter,
} from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const WORKTREE_ROOM = "22222222-3333-4444-5555-666666666666";
const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "ffffffff-1111-2222-3333-444444444444";
const PARENT_MSG = "99999999-8888-7777-6666-555555555555";
const CONNECTOR_MSG = "123456789012345678";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

interface CapturedHandler {
  fn?: (sessionId: string, event: string, data: unknown) => void;
}

const stubbedGlobals = new Map<PropertyKey, unknown>();

function stubGlobalValue(key: keyof typeof globalThis, value: unknown): void {
  if (!stubbedGlobals.has(key)) {
    stubbedGlobals.set(key, globalThis[key]);
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreStubbedGlobals(): void {
  for (const [key, value] of stubbedGlobals.entries()) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  stubbedGlobals.clear();
}

function stubFetch(fetchMock: typeof fetch): void {
  stubGlobalValue("fetch", fetchMock);
}

function makeAcpService(session: SessionInfo): {
  service: {
    onSessionEvent: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    updateSessionMetadata: ReturnType<typeof vi.fn>;
    getChangedPaths: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    sendToSession: ReturnType<typeof vi.fn>;
  };
  emit: (sessionId: string, event: string, data: unknown) => void;
} {
  const captured: CapturedHandler = {};
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
    updateSessionMetadata: vi.fn(
      async (_id: string, patch: Record<string, unknown>) => {
        session.metadata = { ...(session.metadata ?? {}), ...patch };
      },
    ),
    getChangedPaths: vi.fn((_id: string) => [] as string[]),
    sendToSession: vi.fn(async (_id: string, _input: string) => ({})),
  };
  return {
    service,
    emit(sessionId: string, event: string, data: unknown) {
      captured.fn?.(sessionId, event, data);
    },
  };
}

function makeRuntime(opts: {
  acp: unknown;
  agentId?: string;
  setting?: Record<string, string | undefined>;
}) {
  const handleMessage = vi.fn<
    (
      runtime: unknown,
      memory: Memory,
      callback?: HandlerCallback,
    ) => Promise<unknown>
  >(async () => ({}));
  const sendMessageToTarget = vi.fn(
    async (
      _target: { source: string; roomId?: string },
      content: Content,
    ): Promise<Memory> =>
      ({
        id: "aaaaaaaa-0000-0000-0000-000000000000",
        content,
      }) as Memory,
  );
  const createMemory = vi.fn(async () => undefined);
  const createEntity = vi.fn(async () => true);
  const addParticipant = vi.fn(async () => true);
  const emitEvent = vi.fn<
    (name: string, payload: { source: string }) => Promise<void>
  >(async () => undefined);
  const spawnSession = vi.fn(async (o: { workdir?: string }) => ({
    sessionId: "retry-session-id",
    id: "retry-session-id",
    name: "retry",
    agentType: "opencode",
    workdir: o.workdir ?? "/tmp/wf",
    status: "ready",
  }));
  const acpService =
    opts.acp && typeof opts.acp === "object"
      ? { ...(opts.acp as object), spawnSession }
      : opts.acp;
  const runtime = {
    agentId: opts.agentId ?? "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn(() => acpService ?? null),
    getSetting: vi.fn((k: string) => opts.setting?.[k]),
    createMemory,
    createEntity,
    addParticipant,
    emitEvent,
    sendMessageToTarget,
    messageService: { handleMessage },
  } as never;
  return {
    runtime,
    handleMessage,
    createMemory,
    createEntity,
    addParticipant,
    emitEvent,
    sendMessageToTarget,
    spawnSession,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-05-07T12:00:00.000Z");
  return {
    id: SESSION_ID,
    name: "demo-task",
    agentType: "codex",
    workdir: "/tmp/wf",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label: "fix-bug-42",
      roomId: ROOM,
      worldId: WORLD,
      userId: USER,
      messageId: PARENT_MSG,
      source: "telegram",
    },
    ...overrides,
  };
}

describe("SubAgentRouter", () => {
  let session: SessionInfo;
  let acp: ReturnType<typeof makeAcpService>;

  beforeEach(() => {
    session = makeSession();
    acp = makeAcpService(session);
    // The SSRF guard resolves hostnames before fetching. URL-verification
    // tests probe reserved (`*.test`) hosts against a stubbed `fetch`, which
    // would NXDOMAIN under the real resolver. Map any non-loopback host to a
    // public address so the guard passes and the stubbed fetch is exercised;
    // loopback hosts are classified without DNS and need no mapping.
    setHostResolver(async () => [{ address: "93.184.216.34" }]);
  });

  afterEach(() => {
    setHostResolver();
  });

  it("posts a synthetic memory back to the origin room on task_complete", async () => {
    const { runtime, handleMessage, createMemory, createEntity } = makeRuntime({
      acp: acp.service,
    });
    const router = await SubAgentRouter.start(runtime);
    expect(acp.service.onSessionEvent).toHaveBeenCalledTimes(1);

    acp.emit(SESSION_ID, "task_complete", {
      response: "PR opened: github.com/foo/bar/pull/42",
      durationMs: 1234,
    });
    await new Promise((r) => setImmediate(r));

    // The sub-agent entity is created so the memory FK resolves, and the
    // post is delivered via messageService.handleMessage — which persists
    // the memory itself, so the router must NOT also call createMemory
    // (a double-save collides on the primary key).
    expect(createEntity).toHaveBeenCalledTimes(1);
    expect(createMemory).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    if (!posted) throw new Error("expected handleMessage to receive a memory");
    expect(posted.roomId).toBe(ROOM);
    expect(posted.worldId).toBe(WORLD);
    expect(posted.content?.source).toBe("sub_agent");
    expect(posted.content?.inReplyTo).toBe(PARENT_MSG);
    const metadata = posted.content?.metadata as Record<string, unknown>;
    expect(metadata?.subAgent).toBe(true);
    expect(metadata?.subAgentSessionId).toBe(SESSION_ID);
    expect(metadata?.subAgentEvent).toBe("task_complete");
    expect(metadata?.subAgentRoutingKind).toBe("TASK_STATUS");
    expect(metadata?.subAgentTargetRoomId).toBe(ROOM);
    expect(metadata?.subAgentTargetRoomRoles).toEqual(["task"]);
    expect(metadata?.originUserId).toBe(USER);
    expect(typeof posted.content?.text).toBe("string");
    expect(posted.content?.text).toContain("PR opened");

    await router.stop();
  });

  it("carries workdir route metadata into routed terminal messages", async () => {
    session = makeSession({
      metadata: {
        label: "build-app",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        initialTask: "Build the routed static app.",
        workdirRouteId: "static-apps",
        workdirRoute: {
          id: "static-apps",
          workdir: "/tmp/wf",
          instructions: "Write under data/apps/<slug>/.",
          urlMappings: [
            {
              urlPrefix: "https://example.test/apps/",
              localPath: "data/apps/",
            },
          ],
        },
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "Sub-agent state was lost; spawn a fresh sub-agent to continue.",
    });
    await new Promise((r) => setImmediate(r));

    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(metadata?.workdirRouteId).toBe("static-apps");
    expect(metadata?.initialTask).toBe("Build the routed static app.");
    expect(metadata?.workdirRoute).toMatchObject({
      id: "static-apps",
      workdir: "/tmp/wf",
      urlMappings: [
        {
          urlPrefix: "https://example.test/apps/",
          localPath: "data/apps/",
        },
      ],
    });

    await router.stop();
  });

  it("posts terminal updates to deduped deterministic task/worktree swarm rooms", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        taskRoomId: ROOM,
        worktreeRoomId: WORKTREE_ROOM,
        swarmRooms: [
          { roomId: WORKTREE_ROOM, roles: ["worktree"] },
          { roomId: ROOM, roles: ["task"] },
        ],
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage, addParticipant } = makeRuntime({
      acp: acp.service,
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "all done" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls.map((call) => call[1]?.roomId)).toEqual([
      ROOM,
      WORKTREE_ROOM,
    ]);
    expect(addParticipant.mock.calls.map((call) => call[1])).toEqual([
      ROOM,
      WORKTREE_ROOM,
    ]);
    const taskMeta = handleMessage.mock.calls[0]?.[1]?.content
      ?.metadata as Record<string, unknown>;
    const worktreeMeta = handleMessage.mock.calls[1]?.[1]?.content
      ?.metadata as Record<string, unknown>;
    expect(taskMeta.subAgentTargetRoomRoles).toEqual(["task"]);
    expect(worktreeMeta.subAgentTargetRoomRoles).toEqual(["worktree"]);
    expect(taskMeta.subAgentSwarmRooms).toEqual([
      { roomId: ROOM, roles: ["task"] },
      { roomId: WORKTREE_ROOM, roles: ["worktree"] },
    ]);
  });

  it("threads sub-agent planner replies delivered through sendMessageToTarget", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        originConnectorMessageId: CONNECTOR_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage, sendMessageToTarget } = makeRuntime({
      acp: acp.service,
    });
    handleMessage.mockImplementation(async (_runtime, _memory, callback) => {
      await callback?.({ text: "done", inReplyTo: PARENT_MSG });
      return {};
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", {
      response: "done",
    });
    await new Promise((r) => setImmediate(r));

    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
    const routedMeta = handleMessage.mock.calls[0]?.[1]?.content
      ?.metadata as Record<string, unknown>;
    expect(routedMeta.originConnectorMessageId).toBe(CONNECTOR_MSG);
    expect(sendMessageToTarget).toHaveBeenCalledWith(
      {
        source: "telegram",
        roomId: ROOM,
      },
      expect.objectContaining({
        text: "done",
        source: "sub_agent_complete",
        inReplyTo: CONNECTOR_MSG,
      }),
    );
  });

  it("dedupes task/worktree swarm rooms when both roles share one room", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        taskRoomId: ROOM,
        worktreeRoomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage, addParticipant } = makeRuntime({
      acp: acp.service,
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "one room update" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(addParticipant).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(posted?.roomId).toBe(ROOM);
    expect(metadata?.subAgentTargetRoomRoles).toEqual(["task", "worktree"]);
    expect(metadata?.subAgentSwarmRooms).toEqual([
      { roomId: ROOM, roles: ["task", "worktree"] },
    ]);
  });

  it("routes QUESTION_FOR_TASK_CREATOR to the task room with actionable metadata", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        taskRoomId: ROOM,
        worktreeRoomId: WORKTREE_ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "QUESTION_FOR_TASK_CREATOR", {
      question: "Which branch should I target?",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(posted?.roomId).toBe(ROOM);
    expect(posted?.content?.text).toContain("Which branch");
    expect(metadata?.subAgentEvent).toBe("QUESTION_FOR_TASK_CREATOR");
    expect(metadata?.subAgentRoutingKind).toBe("QUESTION_FOR_TASK_CREATOR");
    expect(metadata?.subAgentTargetRoomRole).toBe("task");
    expect(metadata?.taskRoomId).toBe(ROOM);
    expect(metadata?.worktreeRoomId).toBe(WORKTREE_ROOM);
  });

  it("strips leaked routing-kind markdown banners from sub-agent prose", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        taskRoomId: ROOM,
        worktreeRoomId: WORKTREE_ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", {
      response: "**QUESTION_FOR_TASK_CREATOR**\nWhich branch should I target?",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(posted?.roomId).toBe(ROOM);
    expect(posted?.content?.text).toContain("Which branch should I target?");
    expect(posted?.content?.text).not.toContain("QUESTION_FOR_TASK_CREATOR");
    expect(metadata?.subAgentRoutingKind).toBe("QUESTION_FOR_TASK_CREATOR");
  });

  it("does not leak a verify-retry attempt's raw reasoning into the completion", async () => {
    // A verification-retry re-dispatch on a weak model often returns tool-loop
    // reasoning as its "final" text. That must never reach the user as the
    // completion narration — surface a clean header (verified URLs fill in
    // downstream), not the scratchpad.
    session = makeSession({
      metadata: {
        label: "Build a dice roller app",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        buildVerifyRetryCount: 1,
        initialTask: "Build a dice roller app",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", {
      response:
        "I need to call read properly. Seems stuck. Let's retry. Let's glob for public/apps/*. Probably glitch.",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const text = handleMessage.mock.calls[0]?.[1]?.content?.text as string;
    expect(text).not.toContain("Seems stuck");
    expect(text).not.toContain("call read properly");
    expect(text).not.toContain("glob for public");
  });

  it("routes AGENT_COORDINATION to the worktree room with actionable metadata", async () => {
    session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        taskRoomId: ROOM,
        worktreeRoomId: WORKTREE_ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "AGENT_COORDINATION", {
      message: "I am touching router tests.",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(posted?.roomId).toBe(WORKTREE_ROOM);
    expect(posted?.content?.text).toContain("router tests");
    expect(metadata?.subAgentEvent).toBe("AGENT_COORDINATION");
    expect(metadata?.subAgentRoutingKind).toBe("AGENT_COORDINATION");
    expect(metadata?.subAgentTargetRoomRole).toBe("worktree");
    expect(metadata?.taskRoomId).toBe(ROOM);
    expect(metadata?.worktreeRoomId).toBe(WORKTREE_ROOM);
  });

  it("does not inject for streaming events like agent_message_chunk", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "agent_message_chunk", { delta: "thinking…" });
    acp.emit(SESSION_ID, "tool_running", { tool: "Bash" });
    acp.emit(SESSION_ID, "ready", {});
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("dedups duplicate task_complete events with the same payload", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "done", durationMs: 1 });
    acp.emit(SESSION_ID, "task_complete", { response: "done", durationMs: 1 });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup task_complete with a different response", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "first" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "second" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("absorbs cross-session task_complete for the same origin message (cascade-retry dedup)", async () => {
    // Live regression on 2026-05-25 (issue elizaOS/eliza#7967): a single
    // user prompt ("what is the current stable python version") fanned
    // out into 5 sub-agent sessions (1 blocked, 1 errored, 3 task_complete)
    // because the orchestrator auto-respawned on state_lost and verify-
    // retry. Each task_complete posted a separate Discord message — the
    // user saw 3 overlapping replies including a junky analytics URL
    // pulled from python.org's page sub-resources.
    //
    // The dedup is keyed on a completion lineage: a second task_complete
    // from a DIFFERENT session for the SAME parent prompt + task is absorbed
    // silently. Same-session progressive task_completes are unaffected
    // (covered by the test above), and distinct parallel tasks from the same
    // prompt are covered below.
    const SESSION_ID_2 = "abcdef01-2345-6789-abcd-ef0123456789";
    const session2 = makeSession({
      id: SESSION_ID_2,
      name: "demo-task-retry",
      metadata: {
        label: "fix-bug-42-retry",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    const acp2: CapturedHandler = {};
    const service = {
      onSessionEvent: vi.fn((handler: typeof acp2.fn) => {
        acp2.fn = handler;
        return () => {
          acp2.fn = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (id === SESSION_ID_2) return session2;
        return null;
      }),
      listSessions: vi.fn(async () => [session, session2]),
    };
    const { runtime, handleMessage } = makeRuntime({ acp: service });
    await SubAgentRouter.start(runtime);

    acp2.fn?.(SESSION_ID, "task_complete", { response: "first session done" });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).toHaveBeenCalledTimes(1);

    acp2.fn?.(SESSION_ID_2, "task_complete", {
      response: "retry session also done with different text",
    });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("does not absorb distinct parallel task completions for the same origin message", async () => {
    const SESSION_ID_2 = "abcdef01-2345-6789-abcd-ef0123456789";
    const first = makeSession({
      id: SESSION_ID,
      metadata: {
        label: "frontend",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        initialTask: "Review frontend changes",
      },
    });
    const second = makeSession({
      id: SESSION_ID_2,
      name: "backend-task",
      metadata: {
        label: "backend",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        initialTask: "Review backend changes",
      },
    });
    const acp2: CapturedHandler = {};
    const service = {
      onSessionEvent: vi.fn((handler: typeof acp2.fn) => {
        acp2.fn = handler;
        return () => {
          acp2.fn = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return first;
        if (id === SESSION_ID_2) return second;
        return null;
      }),
      listSessions: vi.fn(async () => [first, second]),
    };
    const { runtime, handleMessage } = makeRuntime({ acp: service });
    await SubAgentRouter.start(runtime);

    acp2.fn?.(SESSION_ID, "task_complete", { response: "frontend done" });
    await new Promise((r) => setImmediate(r));
    acp2.fn?.(SESSION_ID_2, "task_complete", { response: "backend done" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("skips sessions without origin metadata (no roomId)", async () => {
    session = makeSession({ metadata: { label: "no-origin" } });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "ignored" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("can be disabled via ACPX_SUB_AGENT_ROUTER_DISABLED", async () => {
    const { runtime, handleMessage } = makeRuntime({
      acp: acp.service,
      setting: { ACPX_SUB_AGENT_ROUTER_DISABLED: "1" },
    });
    await SubAgentRouter.start(runtime);

    expect(acp.service.onSessionEvent).not.toHaveBeenCalled();
    acp.emit(SESSION_ID, "task_complete", { response: "ignored" });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("handles error events with a useful narration", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "acpx exited with code 137 (oom)",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    if (!posted) throw new Error("expected handleMessage to receive a memory");
    expect(posted.content?.text).toContain("acpx exited with code 137");
    expect(
      (posted.content?.metadata as Record<string, unknown>)?.subAgentEvent,
    ).toBe("error");
  });

  it("falls back to MESSAGE_RECEIVED emit if messageService is missing", async () => {
    const { runtime, emitEvent } = makeRuntime({ acp: acp.service });
    delete (runtime as { messageService?: unknown }).messageService;
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "fallback" });
    await new Promise((r) => setImmediate(r));

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const call = emitEvent.mock.calls[0];
    if (!call) throw new Error("expected emitEvent to receive a call");
    expect(call[0]).toBe("MESSAGE_RECEIVED");
    expect((call[1] as { source: string }).source).toBe("sub_agent");
  });

  it("unsubscribes on stop()", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);
    await router.stop();

    acp.emit(SESSION_ID, "task_complete", { response: "after-stop" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("caps round-trips at ACPX_SUB_AGENT_ROUND_TRIP_CAP and force-stops", async () => {
    const stopSession = vi.fn(async () => undefined);
    const acpWithStop = {
      ...acp.service,
      stopSession,
    } as Parameters<typeof makeRuntime>[0]["acp"];
    const { runtime, handleMessage } = makeRuntime({
      acp: acpWithStop,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "3" },
    });
    await SubAgentRouter.start(runtime);

    // 4 distinct task_complete payloads — first 3 deliver, 4th is the cap.
    for (let i = 0; i < 4; i++) {
      acp.emit(SESSION_ID, "task_complete", { response: `iter-${i}` });
      await new Promise((r) => setImmediate(r));
    }

    expect(handleMessage).toHaveBeenCalledTimes(4);
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID);
    const last = handleMessage.mock.calls[3]?.[1];
    if (!last) throw new Error("expected 4th memory");
    const meta = last.content?.metadata as Record<string, unknown>;
    expect(meta?.subAgentCapExceeded).toBe(true);
    expect(meta?.subAgentEvent).toBe("round_trip_cap_exceeded");
    expect(meta?.subAgentRoundTrip).toBe(4);
    expect(meta?.subAgentRoundTripCap).toBe(3);
    expect(last.content?.text).toContain("round-trip cap exceeded");
  });

  it("does not re-fire cap notice if more events arrive after cap exceeded", async () => {
    const stopSession = vi.fn(async () => undefined);
    const acpWithStop = {
      ...acp.service,
      stopSession,
    } as Parameters<typeof makeRuntime>[0]["acp"];
    const { runtime, handleMessage } = makeRuntime({
      acp: acpWithStop,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "1" },
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "first" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "second" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "third" });
    await new Promise((r) => setImmediate(r));

    // first delivers, second triggers cap-exceeded notice (and stop), third is suppressed.
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it("does not count cross-session-suppressed task_completes against the cap", async () => {
    // Regression for the round-trip miscount: the counter incremented before
    // the cross-session completion-dedupe suppression `return`, so a session
    // whose every task_complete is absorbed (because another session already
    // posted for the lineage) still climbed toward — and could spuriously trip
    // — the runaway-loop cap, even though it never posted a single inbound.
    const SESSION_ID_2 = "abcdef01-2345-6789-abcd-ef0123456789";
    const session2 = makeSession({
      id: SESSION_ID_2,
      name: "demo-task-retry",
      metadata: {
        label: "fix-bug-42-retry",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
      },
    });
    const stopSession = vi.fn(async () => undefined);
    const acp2: CapturedHandler = {};
    const service = {
      onSessionEvent: vi.fn((handler: typeof acp2.fn) => {
        acp2.fn = handler;
        return () => {
          acp2.fn = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (id === SESSION_ID_2) return session2;
        return null;
      }),
      listSessions: vi.fn(async () => [session, session2]),
      stopSession,
    };
    // Cap of 1: a single counted round-trip would trip it.
    const { runtime, handleMessage } = makeRuntime({
      acp: service,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "1" },
    });
    await SubAgentRouter.start(runtime);

    // Session A posts once for the lineage.
    acp2.fn?.(SESSION_ID, "task_complete", { response: "first session done" });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // Session B emits several DISTINCT task_completes, all absorbed by the
    // cross-session completion dedupe. None post. With the rollback, B's count
    // never climbs past 0, so its cap (1) is never tripped — no force-stop.
    for (let i = 0; i < 4; i++) {
      acp2.fn?.(SESSION_ID_2, "task_complete", {
        response: `retry done ${i}`,
      });
      await new Promise((r) => setImmediate(r));
    }

    expect(handleMessage).toHaveBeenCalledTimes(1);
    // The suppressed session must not have been force-stopped for tripping the
    // cap on events that never posted.
    expect(stopSession).not.toHaveBeenCalledWith(SESSION_ID_2);
  });

  describe("verify-retry on incomplete builds", () => {
    const origMax = process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
    const origSettle = process.env.ELIZA_URL_VERIFY_SETTLE_MS;

    beforeEach(() => {
      // Disable the settle-retry so the dead-URL probe is a single fast
      // connection-refused rather than a 2.5s wait.
      process.env.ELIZA_URL_VERIFY_SETTLE_MS = "0";
      delete process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
    });
    afterEach(() => {
      if (origMax === undefined)
        delete process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
      else process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES = origMax;
      if (origSettle === undefined)
        delete process.env.ELIZA_URL_VERIFY_SETTLE_MS;
      else process.env.ELIZA_URL_VERIFY_SETTLE_MS = origSettle;
      restoreStubbedGlobals();
    });

    // A localhost port that reliably refuses — fast, no external network.
    const DEAD_URL = "http://127.0.0.1:1/apps/x/";

    function sessionWithTask(
      initialTask: string,
      retryCount?: number,
      extraMetadata: Record<string, unknown> = {},
    ): SessionInfo {
      return makeSession({
        metadata: {
          label: "build-app",
          roomId: ROOM,
          worldId: WORLD,
          userId: USER,
          messageId: PARENT_MSG,
          source: "telegram",
          initialTask,
          ...(retryCount !== undefined
            ? { buildVerifyRetryCount: retryCount }
            : {}),
          ...extraMetadata,
        },
      });
    }

    it("re-dispatches a sub-agent when a claimed URL is unreachable", async () => {
      session = sessionWithTask(
        `build a calculator at ${DEAD_URL}`,
        undefined,
        {
          keepAliveAfterComplete: true,
        },
      );
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — the app is live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const arg = spawnSession.mock.calls[0]?.[0] as {
        initialTask?: string;
        metadata?: Record<string, unknown>;
      };
      expect(arg?.initialTask).toContain("VERIFICATION FEEDBACK");
      expect(arg?.initialTask).toContain("build a calculator");
      expect(arg?.metadata?.buildVerifyRetryCount).toBe(1);
      expect(arg?.metadata?.keepAliveAfterComplete).toBe(false);
      // A retry was spawned → the failure is NOT posted to the parent yet;
      // the retry's own task_complete will report the outcome.
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("redacts loopback URLs from posted verification failures", async () => {
      process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES = "0";
      session = sessionWithTask(`build a calculator at ${DEAD_URL}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — local check failed at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("127.0.0.1");
      expect(posted?.content?.text).not.toContain("localhost");
      expect(posted?.content?.text).not.toContain("::1");
    });

    it("suppresses later original-session errors after handing off to a verification retry", async () => {
      session = sessionWithTask(`build a calculator at ${DEAD_URL}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — the app is live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));
      acp.emit(SESSION_ID, "error", {
        message: '"Method not found": session/cancel',
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("does not surface unsupported session/cancel errors to the user", async () => {
      session = sessionWithTask("build a tiny app");
      acp = makeAcpService(session);
      const { runtime, handleMessage } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "error", {
        message: '"Method not found": session/cancel',
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("stops retrying once the budget is exhausted and posts honestly", async () => {
      // Already at the default max (2) → no further retry.
      session = sessionWithTask(`build it at ${DEAD_URL}`, 2);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).not.toHaveBeenCalled();
      // Budget exhausted → the honest "build incomplete" report IS posted.
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).toContain("NOT reachable");
    });

    it("suppresses an exhausted retry failure when a newer continuation is active", async () => {
      session = sessionWithTask(`build it at ${DEAD_URL}`, 2);
      const newer = {
        ...session,
        id: "11111111-2222-3333-4444-555555555555",
        status: "running",
        createdAt: new Date("2026-05-07T12:01:00.000Z"),
        lastActivityAt: new Date("2026-05-07T12:01:00.000Z"),
      } satisfies SessionInfo;
      acp = makeAcpService(session);
      acp.service.listSessions.mockResolvedValue([session, newer]);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
        setting: { ELIZA_URL_VERIFY_SETTLE_MS: "0" },
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("treats a 405 (reachable, GET-not-allowed) URL as not dead — no retry", async () => {
      // Sub-agents dump raw HTTP headers into their narration; incidental
      // URLs there (CDN telemetry / NEL `report-to`, POST-only APIs) 405 a
      // GET. 405 means the server responded — the URL exists — so it must
      // not be flagged dead and must not trigger a retry of a build that
      // actually succeeded.
      stubFetch(vi.fn(async () => new Response(null, { status: 405 })));
      session = sessionWithTask("build it at https://example.test/apps/x/");
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: "Done — live at https://example.test/apps/x/",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("does not verify repository URLs found while inspecting package metadata", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(
        "Read packages/core/package.json and reply with the package name.",
      );
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          '[tool output: Read packages/core/package.json]\n{"name":"@elizaos/core","homepage":"https://github.com/elizaOS/eliza","repository":{"type":"git","url":"git+https://github.com/elizaOS/eliza.git","directory":"packages/core"}}\n[/tool output]\n@elizaos/core',
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).toContain("@elizaos/core");
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("ignores route-template URL stems when a concrete app URL verifies", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://example.test/apps/") {
          return new Response("not found", { status: 404 });
        }
        if (url === "https://example.test/apps/counter/") {
          return new Response('<script src="app.js"></script>', {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url === "https://example.test/apps/counter/app.js") {
          return new Response("let count = 0;", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask("build a counter");
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "Route note: verify https://example.test/apps/<slug>/. Built and verified https://example.test/apps/counter/",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(fetchMock).not.toHaveBeenCalledWith(
        "https://example.test/apps/",
        expect.anything(),
      );
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("stores verified reference URLs in metadata when completion text omits them", async () => {
      const appBase = "https://example.test/apps/reference-only/";
      const fetchMock = vi.fn(async () => {
        return new Response("<html><body>ok</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build and verify ${appBase}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: "Created the app directory and files.",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      const metadata = posted?.content?.metadata as
        | Record<string, unknown>
        | undefined;
      expect(metadata?.subAgentVerifiedUrls).toEqual([appBase]);
    });

    it("uses verified URLs instead of raw tool-only completion transcripts", async () => {
      const appBase = "https://example.test/apps/tool-only/";
      stubFetch(
        vi.fn(async () => {
          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }),
      );
      session = sessionWithTask(`build and verify ${appBase}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "[tool output: Write file]\nWrote file successfully.\n[/tool output]",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).toContain(appBase);
      expect(posted?.content?.text).not.toContain("[tool output:");
    });

    it("keeps asset-only completions while recording verified routed page URLs", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sub-agent-router-"),
      );
      try {
        const appDir = path.join(tmpRoot, "data/apps/random-tweet");
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(
          path.join(appDir, "index.html"),
          '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
        );
        fs.writeFileSync(
          path.join(appDir, "style.css"),
          "body { color: red; }",
        );
        fs.writeFileSync(path.join(appDir, "app.js"), "console.log('ok');");
        const localPage = "http://127.0.0.1:6900/apps/random-tweet/";
        const publicPage = "https://example.test/apps/random-tweet/";
        const localStyle = `${localPage}style.css`;
        const publicScript = `${publicPage}app.js`;
        stubFetch(
          vi.fn(async () => {
            return new Response("ok", { status: 200 });
          }) as typeof fetch,
        );
        session = {
          ...sessionWithTask(`build and verify ${publicPage}`, undefined, {
            workdirRoute: {
              id: "static-apps",
              workdir: tmpRoot,
              urlMappings: [
                {
                  urlPrefix: "http://127.0.0.1:6900/apps/",
                  localPath: "data/apps/",
                },
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                  requireFresh: true,
                },
              ],
            },
          }),
          workdir: tmpRoot,
        };
        acp = makeAcpService(session);
        const { runtime, handleMessage, spawnSession } = makeRuntime({
          acp: acp.service,
        });
        await SubAgentRouter.start(runtime);

        acp.emit(SESSION_ID, "task_complete", {
          response: `${localStyle}\n${publicScript}`,
        });
        await new Promise((r) => setTimeout(r, 200));

        expect(spawnSession).not.toHaveBeenCalled();
        expect(handleMessage).toHaveBeenCalledTimes(1);
        const posted = handleMessage.mock.calls[0]?.[1];
        expect(posted?.content?.text).not.toContain(localPage);
        expect(posted?.content?.text).toContain(publicPage);
        expect(posted?.content?.metadata?.subAgentVerifiedUrls).toEqual([
          publicPage,
        ]);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("does not surface route-prefix or data-source URLs as the deliverable for a non-build info-fetch", async () => {
      // Live BTC regression (2026-06-13): a "what's BTC worth?" turn routed to
      // the agent-home apps route. The spawn task carried the route's
      // `--- URL Path Mapping ---` hint verbatim (so `initialTask`, the verify
      // reference text, contained the bare `https://host/apps/` prefix) plus the
      // CoinGecko data-source URL the sub-agent was told to fetch. Both probed
      // 200, were promoted to `subAgentVerifiedUrls`, and the bare apps prefix
      // was surfaced as the reply — clobbering the real answer. None of these
      // URLs is a hosted-artifact PAGE the sub-agent built, so none may surface.
      const appsPrefixPublic = "https://example.test/apps/";
      const appsPrefixLocal = "http://127.0.0.1:6900/apps/";
      const dataSource =
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
      // Everything the verifier could probe is reachable — the bug is purely
      // that reachable != deliverable for these URLs.
      const fetchMock = vi.fn(async () => {
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      });
      stubFetch(fetchMock as typeof fetch);
      session = sessionWithTask(
        [
          "--- URL Path Mapping ---",
          "These mappings are authoritative for hosted artifacts:",
          `- URL prefix ${appsPrefixPublic} maps to local path data/apps. For ${appsPrefixPublic}<slug>/, write files under data/apps/<slug>/.`,
          `- URL prefix ${appsPrefixLocal} maps to local path data/apps. For ${appsPrefixLocal}<slug>/, write files under data/apps/<slug>/.`,
          "--- User Task ---",
          `Use the webfetch tool to GET this exact URL: ${dataSource}`,
          "Reply with ONLY the USD number value from the response.",
        ].join("\n"),
        undefined,
        {
          workdirRoute: {
            id: "static-apps",
            workdir: "/tmp/agent-home",
            urlMappings: [
              { urlPrefix: appsPrefixLocal, localPath: "data/apps/" },
              { urlPrefix: appsPrefixPublic, localPath: "data/apps/" },
            ],
          },
        },
      );
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "DECISION: task complete — reporting the fetched value.\n\n**64223**",
      });
      await new Promise((r) => setTimeout(r, 300));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      const text = posted?.content?.text ?? "";
      // The real answer is preserved; no stray URL leaks into the reply.
      expect(text).toContain("64223");
      expect(text).not.toContain("/apps/");
      expect(text).not.toContain("coingecko");
      // No URL was a built deliverable, so none is recorded as verified.
      const verified = posted?.content?.metadata?.subAgentVerifiedUrls as
        | unknown[]
        | undefined;
      expect(verified ?? []).toEqual([]);
    });

    it("rejects generated app pages that reference unreachable image assets", async () => {
      const appUrl = "https://example.test/apps/permit-garden/";
      const imageUrl = "https://cdn.example.test/permit-garden/sticker.png";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === imageUrl) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          `<!doctype html><img src="${imageUrl}" alt="Sticker">`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build and verify ${appUrl}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
        setting: { ELIZA_URL_VERIFY_SETTLE_MS: "0" },
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${appUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const retryTask = String(spawnSession.mock.calls[0]?.[0]?.initialTask);
      expect(retryTask).toContain("--- VERIFICATION FEEDBACK");
      expect(retryTask).toContain(imageUrl);
      expect(retryTask).toContain("HTTP 404");
      expect(handleMessage).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(imageUrl, expect.anything());
    });

    it("does not reject a served-200 mapped app URL for stale local mtime (GAP-C: live 200 is authoritative)", async () => {
      // A deploy step that copies a build into place preserves the source
      // file's mtime, so a healthy app can have files older than the session.
      // The live HTTP 200 is authoritative — the wall-clock freshness gate must
      // not false-flag it as stale (which used to spuriously suppress
      // task_complete and withhold the real diff from "what did you change?").
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sub-agent-router-"),
      );
      try {
        const appUrl = "https://example.test/apps/random-tweet-generator/";
        const staleDir = path.join(tmpRoot, "data/apps/random-tweet-generator");
        fs.mkdirSync(staleDir, { recursive: true });
        const staleIndex = path.join(staleDir, "index.html");
        fs.writeFileSync(staleIndex, "<html><body>old app</body></html>");
        const staleTime = new Date("2026-05-07T11:00:00.000Z");
        fs.utimesSync(staleIndex, staleTime, staleTime);

        const fetchMock = vi.fn(async () => {
          return new Response("<html><body>old app</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        });
        stubFetch(fetchMock);
        session = {
          ...sessionWithTask(`build and verify ${appUrl}`, 2, {
            workdirRoute: {
              id: "static-apps",
              workdir: tmpRoot,
              urlMappings: [
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                },
              ],
            },
          }),
          workdir: tmpRoot,
        };
        acp = makeAcpService(session);
        const { runtime, handleMessage, spawnSession } = makeRuntime({
          acp: acp.service,
        });
        await SubAgentRouter.start(runtime);

        acp.emit(SESSION_ID, "task_complete", {
          response: `Wrote files under apps/random-tweet-generator/. Public URL ${appUrl}`,
        });
        await new Promise((r) => setTimeout(r, 200));

        // No spurious verify-retry, and the completion turn is posted as-is.
        expect(spawnSession).not.toHaveBeenCalled();
        expect(handleMessage).toHaveBeenCalledTimes(1);
        const posted = handleMessage.mock.calls[0]?.[1];
        expect(posted?.content?.text).not.toContain(
          "not updated during this session",
        );
        expect(posted?.content?.text).not.toContain("[verification:");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("does not reject a reachable mapped app URL for stale local mtime when freshness is explicitly disabled", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sub-agent-router-"),
      );
      try {
        const appUrl = "https://example.test/apps/random-tweet-idea/";
        const appDir = path.join(tmpRoot, "data/apps/random-tweet-idea");
        fs.mkdirSync(appDir, { recursive: true });
        const indexFile = path.join(appDir, "index.html");
        fs.writeFileSync(indexFile, "<html><body>existing app</body></html>");
        const staleTime = new Date("2026-05-07T11:00:00.000Z");
        fs.utimesSync(indexFile, staleTime, staleTime);

        stubFetch(
          vi.fn(async () => {
            return new Response("<html><body>existing app</body></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }),
        );
        session = {
          ...sessionWithTask(`build and verify ${appUrl}`, undefined, {
            workdirRoute: {
              id: "static-apps",
              workdir: tmpRoot,
              urlMappings: [
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                  requireFresh: false,
                },
              ],
            },
          }),
          workdir: tmpRoot,
        };
        acp = makeAcpService(session);
        const { runtime, handleMessage, spawnSession } = makeRuntime({
          acp: acp.service,
        });
        await SubAgentRouter.start(runtime);

        acp.emit(SESSION_ID, "task_complete", {
          response: `Done — live at ${appUrl}`,
        });
        await new Promise((r) => setTimeout(r, 200));

        expect(spawnSession).not.toHaveBeenCalled();
        expect(handleMessage).toHaveBeenCalledTimes(1);
        const posted = handleMessage.mock.calls[0]?.[1];
        expect(posted?.content?.text).not.toContain("[verification:");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("rejects mapped app URLs when the sub-agent wrote an unserved sibling path", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sub-agent-router-"),
      );
      try {
        const appUrl = "https://example.test/apps/compliance-candy/";
        const wrongDir = path.join(tmpRoot, "apps/compliance-candy");
        fs.mkdirSync(wrongDir, { recursive: true });
        fs.writeFileSync(
          path.join(wrongDir, "index.html"),
          "<html><body>wrong path</body></html>",
        );
        stubFetch(
          vi.fn(async () => {
            return new Response("<html><body>ok</body></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }),
        );
        session = {
          ...sessionWithTask(`build and verify ${appUrl}`, 2, {
            workdirRoute: {
              id: "static-apps",
              workdir: tmpRoot,
              urlMappings: [
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                },
              ],
            },
          }),
          workdir: tmpRoot,
        };
        acp = makeAcpService(session);
        const { runtime, handleMessage, spawnSession } = makeRuntime({
          acp: acp.service,
        });
        await SubAgentRouter.start(runtime);

        acp.emit(SESSION_ID, "task_complete", {
          response: `Wrote apps/compliance-candy/index.html. Public URL ${appUrl}`,
        });
        await new Promise((r) => setTimeout(r, 200));

        expect(spawnSession).not.toHaveBeenCalled();
        expect(handleMessage).toHaveBeenCalledTimes(1);
        const posted = handleMessage.mock.calls[0]?.[1];
        expect(posted?.content?.text).toContain(
          "mapped local target missing or empty",
        );
        // The mapped local path can be rendered with the host's native
        // separator (POSIX `/` vs Windows `\`). Accept either.
        expect(posted?.content?.text).toMatch(
          /data[\\/]apps[\\/]compliance-candy/,
        );
        expect(posted?.content?.text).toContain("[verification:");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("ignores model-introduced same-path external URL aliases when the requested target verifies", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://127.0.0.1:6900/apps/asset-check/") {
          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url === "https://example.test/apps/asset-check/") {
          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(
        "build and verify https://example.test/apps/asset-check/",
      );
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "Done — local: http://127.0.0.1:6900/apps/asset-check/, mirror: https://wrong.example.test/apps/asset-check/, public: https://example.test/apps/asset-check/",
      });
      await new Promise((r) => setTimeout(r, 200));

      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toContain("http://127.0.0.1:6900/apps/asset-check/");
      expect(fetched).toContain("https://example.test/apps/asset-check/");
      expect(fetched).not.toContain(
        "https://wrong.example.test/apps/asset-check/",
      );
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("adds verified public route aliases when a completion only mentions loopback", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sub-agent-router-"),
      );
      try {
        const localUrl = "http://127.0.0.1:6900/apps/tea-fortune/";
        const publicUrl = "https://example.test/apps/tea-fortune/";
        const appDir = path.join(tmpRoot, "data/apps/tea-fortune");
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(
          path.join(appDir, "index.html"),
          "<html><body>tea fortunes</body></html>",
        );
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === localUrl || url === publicUrl) {
            return new Response("<html><body>tea fortunes</body></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return new Response("not found", { status: 404 });
        });
        stubFetch(fetchMock);
        session = {
          ...sessionWithTask(`build and verify ${publicUrl}`, undefined, {
            workdirRoute: {
              id: "static-apps",
              workdir: tmpRoot,
              urlMappings: [
                {
                  urlPrefix: "http://127.0.0.1:6900/apps/",
                  localPath: "data/apps/",
                },
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                },
              ],
            },
          }),
          workdir: tmpRoot,
        };
        acp = makeAcpService(session);
        const { runtime, handleMessage, spawnSession } = makeRuntime({
          acp: acp.service,
        });
        await SubAgentRouter.start(runtime);

        acp.emit(SESSION_ID, "task_complete", {
          response: localUrl,
        });
        await new Promise((r) => setTimeout(r, 200));

        const fetched = fetchMock.mock.calls.map(([url]) => String(url));
        expect(fetched).toContain(localUrl);
        expect(fetched).toContain(publicUrl);
        expect(spawnSession).not.toHaveBeenCalled();
        expect(handleMessage).toHaveBeenCalledTimes(1);
        const posted = handleMessage.mock.calls[0]?.[1];
        expect(posted?.content?.metadata?.subAgentVerifiedUrls).toEqual([
          publicUrl,
        ]);
        expect(posted?.content?.text).not.toContain(localUrl);
        expect(posted?.content?.text).toContain(publicUrl);
        expect(posted?.content?.text).not.toContain("[verification:");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("focuses verification on the referenced app route instead of header telemetry", async () => {
      const appBase = "https://example.test/apps/cache-safe/";
      const styleUrl = `${appBase}style-v2.css`;
      const scriptUrl = `${appBase}app-v2.js`;
      const telemetryUrl =
        "https://a.nel.cloudflare.com/report/v4?s=header-noise";
      const unrelatedUrl = "https://example.test/apps/recipe-4/style.css";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === styleUrl) {
          return new Response("body { color: green; }", {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        if (url === scriptUrl) {
          return new Response("console.log('ok');", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build and verify ${appBase}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Header noise ${telemetryUrl}; stale context ${unrelatedUrl}; fixed assets ${styleUrl} ${scriptUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toEqual([styleUrl, scriptUrl]);
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("marks cached 404s so retries can switch to fresh asset filenames", async () => {
      const assetUrl = "https://example.test/apps/counter/style.css";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(`${assetUrl}?__eliza_verify=`)) {
          return new Response("body { color: red; }", {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        if (url === assetUrl) {
          return new Response("not found", {
            status: 404,
            headers: {
              age: "42",
              "cf-cache-status": "HIT",
              "cache-control": "max-age=14400",
            },
          });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build a counter at ${assetUrl}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${assetUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched.some((url) => url.startsWith(`${assetUrl}?`))).toBe(true);
      const retryTask = String(spawnSession.mock.calls[0]?.[0]?.initialTask);
      expect(retryTask).toMatch(/^--- VERIFICATION FEEDBACK/);
      expect(retryTask).toContain("overrides conflicting filename");
      expect(retryTask).toContain("cached stale miss");
      expect(retryTask).toContain("Their exact filenames are unavailable");
      expect(retryTask).toContain("Create fresh asset filenames");
      const retryMetadata = spawnSession.mock.calls[0]?.[0]?.metadata as
        | Record<string, unknown>
        | undefined;
      expect(retryMetadata?.cachedStaleMissUrls).toEqual([assetUrl]);
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("cache-bust probes 404s even when the edge omits cache headers", async () => {
      const assetUrl = "https://example.test/apps/counter/app.js";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(`${assetUrl}?__eliza_verify=`)) {
          return new Response("console.log('fresh');", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        if (url === assetUrl) {
          return new Response("not found", { status: 404 });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build a counter at ${assetUrl}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${assetUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toContain(assetUrl);
      expect(fetched.some((url) => url.startsWith(`${assetUrl}?`))).toBe(true);
      const retryTask = String(spawnSession.mock.calls[0]?.[0]?.initialTask);
      expect(retryTask).toMatch(/^--- VERIFICATION FEEDBACK/);
      expect(retryTask).toContain("overrides conflicting filename");
      expect(retryTask).toContain("cached stale miss");
      expect(retryTask).toContain("Their exact filenames are unavailable");
      expect(retryTask).toContain("Create fresh asset filenames");
      const retryMetadata = spawnSession.mock.calls[0]?.[0]?.metadata as
        | Record<string, unknown>
        | undefined;
      expect(retryMetadata?.cachedStaleMissUrls).toEqual([assetUrl]);
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("does not re-check stale cached URLs after a retry switches to fresh filenames", async () => {
      const staleUrl = "https://example.test/apps/counter/style.css";
      const freshUrl = "https://example.test/apps/counter/style-v2.css";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === freshUrl) {
          return new Response("body { color: green; }", {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      stubFetch(fetchMock);
      session = sessionWithTask(`build a counter at ${staleUrl}`, 1, {
        cachedStaleMissUrls: [staleUrl],
      });
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `The cached URL ${staleUrl} is stale; the app now uses ${freshUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toEqual([freshUrl]);
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("does not retry when ELIZA_BUILD_VERIFY_MAX_RETRIES=0", async () => {
      process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES = "0";
      session = sessionWithTask(`build it at ${DEAD_URL}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("extractSubResources", () => {
  const PAGE = "https://example.test/apps/bmi/index.html";

  it("extracts <link href> and <script src>, resolved absolute", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="style.css" />
      </head><body><script src="app.js"></script></body></html>`;
    expect(extractSubResources(html, PAGE).sort()).toEqual([
      "https://example.test/apps/bmi/app.js",
      "https://example.test/apps/bmi/style.css",
    ]);
  });

  it("extracts media src and srcset resources", () => {
    const html = `<!doctype html><img src="hero.png" srcset="hero-small.png 480w, https://cdn.example.com/hero-large.png 960w">
      <source srcset="poster.webp 1x, poster@2x.webp 2x">`;
    expect(extractSubResources(html, PAGE).sort()).toEqual([
      "https://cdn.example.com/hero-large.png",
      "https://example.test/apps/bmi/hero-small.png",
      "https://example.test/apps/bmi/hero.png",
      "https://example.test/apps/bmi/poster.webp",
      "https://example.test/apps/bmi/poster@2x.webp",
    ]);
  });

  it("resolves absolute and root-relative refs", () => {
    const html = `<link href="/global.css"><script src="https://cdn.example.com/lib.js"></script>`;
    expect(extractSubResources(html, PAGE).sort()).toEqual([
      "https://cdn.example.com/lib.js",
      "https://example.test/global.css",
    ]);
  });

  it("skips in-page anchors and data:/mailto: refs", () => {
    const html = `<link href="#top"><script src="data:text/javascript,1"></script><a href="mailto:x@y.z">m</a>`;
    expect(extractSubResources(html, PAGE)).toEqual([]);
  });

  it("returns [] for HTML with no sub-resources", () => {
    expect(extractSubResources("<html><body>hi</body></html>", PAGE)).toEqual(
      [],
    );
  });

  it("caps the result so a pathological page can't fan out unbounded", () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `<script src="s${i}.js"></script>`,
    ).join("");
    expect(extractSubResources(many, PAGE).length).toBe(10);
  });
});

describe("normalizeUrlsInText", () => {
  it("replaces a Unicode non-breaking hyphen inside a URL with ASCII hyphen", () => {
    // gpt-oss-class models emit U+2011 where they meant "-", so the link
    // 404s even though the directory exists under the ASCII-hyphen name.
    const text = "app is live at https://example.test/apps/bmi‑calc‑1/";
    expect(normalizeUrlsInText(text)).toBe(
      "app is live at https://example.test/apps/bmi-calc-1/",
    );
  });

  it("normalizes en dash and em dash inside URLs", () => {
    const text = "see http://localhost:6900/apps/my–app—1/index.html";
    expect(normalizeUrlsInText(text)).toBe(
      "see http://localhost:6900/apps/my-app-1/index.html",
    );
  });

  it("leaves dashes in surrounding prose untouched — only URLs are normalized", () => {
    const text = "the build finished — see https://x.org/a‑b/";
    expect(normalizeUrlsInText(text)).toBe(
      "the build finished — see https://x.org/a-b/",
    );
  });

  it("normalizes every URL when several are present", () => {
    const text = "http://127.0.0.1/a‑b/ and https://example.test/c‑d/";
    expect(normalizeUrlsInText(text)).toBe(
      "http://127.0.0.1/a-b/ and https://example.test/c-d/",
    );
  });

  it("returns text unchanged when it contains no URLs", () => {
    expect(normalizeUrlsInText("just some prose — no links")).toBe(
      "just some prose — no links",
    );
  });
});

describe("extractShortToolDeliverable", () => {
  it("recovers the inner body of a single short tool-output block", () => {
    const data = {
      response:
        "Done.\n[tool output: bash]\n42 files matched the pattern.\n[/tool output]",
    };
    expect(extractShortToolDeliverable(data)).toBe(
      "42 files matched the pattern.",
    );
  });

  it("reads from finalText when response is absent", () => {
    const data = {
      finalText: "[tool output: cat]\nhello world\n[/tool output]",
    };
    expect(extractShortToolDeliverable(data)).toBe("hello world");
  });

  it("returns undefined for multiple tool-output blocks (stays on model path)", () => {
    const data = {
      response:
        "[tool output: a]\none\n[/tool output]\n[tool output: b]\ntwo\n[/tool output]",
    };
    expect(extractShortToolDeliverable(data)).toBeUndefined();
  });

  it("returns undefined when the block exceeds the 2KB verbatim gate", () => {
    const big = "x".repeat(2049);
    const data = { response: `[tool output: dump]\n${big}\n[/tool output]` };
    expect(extractShortToolDeliverable(data)).toBeUndefined();
  });

  it("relays a block at the 2KB boundary verbatim", () => {
    const atCap = "y".repeat(2048);
    const data = { response: `[tool output: dump]\n${atCap}\n[/tool output]` };
    expect(extractShortToolDeliverable(data)).toBe(atCap);
  });

  it("returns undefined when there is no tool-output block", () => {
    expect(
      extractShortToolDeliverable({ response: "just prose, no tools" }),
    ).toBeUndefined();
  });

  it("returns undefined when the block body is empty", () => {
    expect(
      extractShortToolDeliverable({
        response: "[tool output: noop]\n\n[/tool output]",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when there is no captured response payload", () => {
    expect(extractShortToolDeliverable({})).toBeUndefined();
    expect(extractShortToolDeliverable(null)).toBeUndefined();
  });
});

describe("redactLoopbackUrls", () => {
  // Live regression: on 2026-05-25 a "make me a 1-page PDF" sub-agent
  // task ran successfully but the sub-agent's task report mentioned
  // `http://127.0.0.1:6900/apps/` (it had curl-probed a local dev URL
  // while diagnosing whether a build was deployed). That internal URL
  // leaked into Discord across THREE separate task_complete events:
  //   "Both URLs returned HTTP 404 Not Found, so they aren't reachable..."
  //   "http://127.0.0.1:6900/apps/ → HTTP 404 Not Found..."
  //   "Confirmed the HTTP checks: http://127.0.0.1:6900/apps/ ..."
  // The user-facing reply must never contain loopback URLs — they are
  // unreachable from the user's machine, leak internal addresses, and
  // make the bot look broken. The URL verification pipeline (which can
  // legitimately probe loopback in dev-app scenarios) is unaffected;
  // this function only scrubs the OUTGOING text right before posting.
  it("strips http://127.0.0.1 URLs and keeps the surrounding sentence readable", () => {
    expect(
      redactLoopbackUrls(
        "The checks show http://127.0.0.1:6900/apps/ returned 404.",
      ),
    ).toBe("The checks show  returned 404.");
  });

  it("strips http://localhost URLs across all ports", () => {
    expect(
      redactLoopbackUrls("Local at http://localhost:3000/dashboard works."),
    ).toBe("Local at  works.");
  });

  it("redacts repeated calls even after a prior global-regex match", () => {
    expect(redactLoopbackUrls("first http://127.0.0.1:3000/a")).toBe("first");
    expect(redactLoopbackUrls("http://127.0.0.1:3000/b second")).toBe("second");
  });

  it("strips 127.x.x.x address space (not just 127.0.0.1)", () => {
    expect(redactLoopbackUrls("see http://127.5.4.3:8080/")).toBe("see");
  });

  it("strips https:// loopback URLs as well as http://", () => {
    // Leading whitespace at start of trimmed output collapses; both
    // shapes are acceptable as long as the URL itself is gone and the
    // word "failed" remains intact.
    const out = redactLoopbackUrls("https://localhost:8443/api/health failed");
    expect(out).not.toContain("localhost");
    expect(out).toContain("failed");
  });

  it("keeps public URLs that share the same path as the loopback URL", () => {
    // Verification design: even when a loopback alias is detected for
    // a public route, the PUBLIC URL is what the user can see — it must
    // survive the redaction.
    const text =
      "Local: http://127.0.0.1:6900/apps/x/ — Public: https://nubilio.org/apps/x/";
    expect(redactLoopbackUrls(text)).toContain("https://nubilio.org/apps/x/");
    expect(redactLoopbackUrls(text)).not.toContain("127.0.0.1");
  });

  it("removes orphan bullet lines that become only punctuation after URL strip", () => {
    const text =
      "Build complete!\n- http://127.0.0.1:6900/apps/main/\n- https://example.test/\nDone.";
    const out = redactLoopbackUrls(text);
    expect(out).not.toContain("127.0.0.1");
    expect(out).toContain("https://example.test/");
    expect(out).toContain("Build complete!");
    expect(out).toContain("Done.");
  });

  it("returns text unchanged when no loopback URLs are present", () => {
    const text = "Public URL: https://nubilio.org/apps/x/ is reachable.";
    expect(redactLoopbackUrls(text)).toBe(text);
  });

  it("handles ::1 IPv6 loopback host (bracketed and unbracketed)", () => {
    expect(redactLoopbackUrls("dev at http://[::1]:3000/health is up")).toBe(
      "dev at  is up",
    );
  });
});

describe("SubAgentRouter state_lost respawn cap", () => {
  afterEach(() => {
    restoreStubbedGlobals();
  });

  it("bounds the cross-session state_lost respawn cascade per origin lineage", async () => {
    // Live regression (milady dog-site, 2026-05-28): a dying sub-agent emitted
    // an "error"/session_state_lost event every ~60s; each respawn was a NEW
    // sessionId so the per-session roundTripCap never fired -> unbounded loop.
    // The per-origin cap (taskRoomId+agentType, default 3) bounds the lineage.
    // Here the sessions carry NO initialTask, so deterministic in-router
    // recovery can't reconstruct the work — each under-cap failure falls
    // through to an honest error post, and the over-cap event posts exactly
    // one terminal failure (deduped) instead of hanging silently.
    stubFetch(vi.fn(async () => new Response("", { status: 200 })) as never);
    const captured: { fn?: (s: string, e: string, d: unknown) => void } = {};
    const stopSession = vi.fn(async () => undefined);
    const sharedMeta = {
      label: "Update the dog site",
      roomId: ROOM,
      worldId: WORLD,
      userId: USER,
      // messageId rotates per respawn (the synthetic-inbound id) — exactly the
      // dimension that broke the old lineage key; the new key ignores it.
      messageId: PARENT_MSG,
      source: "discord",
    };
    const acpService = {
      onSessionEvent: vi.fn((h: (s: string, e: string, d: unknown) => void) => {
        captured.fn = h;
        return () => {
          captured.fn = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => ({
        id,
        name: id,
        agentType: "opencode",
        workdir: "/tmp/wf",
        status: "running",
        approvalPreset: "standard",
        createdAt: new Date("2026-05-28T23:40:00.000Z"),
        lastActivityAt: new Date("2026-05-28T23:40:00.000Z"),
        metadata: { ...sharedMeta, messageId: `msg-${id}` },
      })),
      listSessions: vi.fn(async () => []),
      stopSession,
    };
    const { runtime, handleMessage } = makeRuntime({ acp: acpService });
    const router = await SubAgentRouter.start(runtime);

    // 5 events: distinct sessionIds, same origin room (taskRoomId fallback)
    // + agentType. Cap=3 -> events 1..3 post honest errors, event 4 posts one
    // terminal failure, event 5 suppressed.
    for (let i = 1; i <= 5; i++) {
      captured.fn?.(`sess-${i}-0000-0000-0000-00000000000${i}`, "error", {
        message:
          "Sub-agent state was lost (process exited without persisting). No automatic action taken.",
        failureKind: "session_state_lost",
      });
      await new Promise((r) => setImmediate(r));
    }

    expect(handleMessage).toHaveBeenCalledTimes(4);
    const terminal = handleMessage.mock.calls[3]?.[1];
    expect(
      (terminal?.content?.metadata as Record<string, unknown> | undefined)
        ?.subAgentEvent,
    ).toBe("state_lost_exhausted");
    // The over-cap session is force-stopped instead of re-injected.
    expect(stopSession).toHaveBeenCalled();
    await router.stop();
  });
});

describe("SubAgentRouter — change-set narration (GAP C)", () => {
  afterEach(() => {
    restoreStubbedGlobals();
    vi.restoreAllMocks();
  });

  it("builds the completion narration from the real git diff, not the raw transcript", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gapc-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "index.html"), "<h1>placeholder</h1>\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .trim();
      // The sub-agent's actual edit (an image/content swap), uncommitted.
      fs.writeFileSync(
        path.join(repo, "index.html"),
        "<h1>a real dog photo</h1>\n",
      );

      const session = makeSession({
        workdir: repo,
        metadata: {
          label: "dogsite-update",
          roomId: ROOM,
          worldId: WORLD,
          userId: USER,
          messageId: PARENT_MSG,
          source: "telegram",
          initialTask: "update the dog site",
          codingBaselineSha: baseline,
        },
      });
      const acp = makeAcpService(session);
      const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
      await SubAgentRouter.start(runtime);

      // The raw model transcript that previously leaked verbatim to Discord.
      acp.emit(SESSION_ID, "task_complete", {
        response:
          "[tool output: Read index.html]\n<h1>placeholder</h1>\n[/tool output]\nSearch for the image element.",
      });
      await new Promise((r) => setTimeout(r, 200));

      const posted = handleMessage.mock.calls[0]?.[1];
      const text = String(posted?.content?.text ?? "");
      // Grounded in the real change set...
      expect(text).toContain("index.html");
      // ...with neither the raw tool-output blocks nor the plan-narration.
      expect(text).not.toContain("[tool output:");
      expect(text).not.toContain("Search for the image element");

      // And the change set is persisted for the "show me the diff" provider.
      expect(acp.service.updateSessionMetadata).toHaveBeenCalled();
      const patch = acp.service.updateSessionMetadata.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined;
      const changeSet = patch?.lastChangeSet as
        | { changedFiles?: string[]; diff?: string }
        | undefined;
      expect(changeSet?.changedFiles).toContain("index.html");
      expect(changeSet?.diff).toContain("a real dog photo");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("persists NO change set on a no-op completion (recency is modeled on the session, not a sentinel)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gapc-noop-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "index.html"), "<h1>unchanged</h1>\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .trim();
      // No file edits this session.
      const session = makeSession({
        workdir: repo,
        metadata: {
          label: "noop-task",
          roomId: ROOM,
          worldId: WORLD,
          userId: USER,
          messageId: PARENT_MSG,
          source: "telegram",
          initialTask: "have a look around",
          codingBaselineSha: baseline,
        },
      });
      const acp = makeAcpService(session);
      const { runtime } = makeRuntime({ acp: acp.service });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", { response: "Nothing to change." });
      await new Promise((r) => setTimeout(r, 200));

      // No change => no lastChangeSet persisted. The provider selects the
      // most-recently-active session and finds no change set, so an older
      // task's diff can't bleed in — without inventing a sentinel.
      const persistedChangeSet =
        acp.service.updateSessionMetadata.mock.calls.some(
          (call) =>
            (call?.[1] as Record<string, unknown> | undefined)
              ?.lastChangeSet !== undefined,
        );
      expect(persistedChangeSet).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("SubAgentRouter — deterministic session_state_lost recovery", () => {
  const STATE_LOST = {
    failureKind: "session_state_lost",
    message: "Sub-agent state was lost.",
  };

  it("recovers in-router and posts nothing to the user (no crash narration)", async () => {
    const session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        initialTask: "Fix the failing test in foo.ts",
      },
    });
    const acp = makeAcpService(session);
    const { runtime, handleMessage, spawnSession } = makeRuntime({
      acp: acp.service,
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", STATE_LOST);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Recovery is deterministic and silent: a replacement was spawned with the
    // original task and origin metadata, the dead session was stopped, and the
    // user saw NOTHING (the child's own task_complete will be the only reply).
    expect(spawnSession).toHaveBeenCalledTimes(1);
    const spawnArg = spawnSession.mock.calls[0]?.[0] as {
      initialTask?: string;
      metadata?: Record<string, unknown>;
    };
    expect(spawnArg?.initialTask).toBe("Fix the failing test in foo.ts");
    expect(spawnArg?.metadata?.roomId).toBe(ROOM);
    expect(spawnArg?.metadata?.retryOfSessionId).toBe(SESSION_ID);
    expect(acp.service.stopSession).toHaveBeenCalledWith(SESSION_ID);
    expect(handleMessage).not.toHaveBeenCalled();

    // The dead session's tail events are suppressed — a late task_complete on
    // the lost session must not double-post.
    acp.emit(SESSION_ID, "task_complete", { response: "stale ghost reply" });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("surfaces an honest failure when there is no original task to respawn", async () => {
    // Default session carries no initialTask → respawn can't reconstruct the
    // work, so the user gets an honest error report instead of silence.
    const session = makeSession();
    const acp = makeAcpService(session);
    const { runtime, handleMessage, spawnSession } = makeRuntime({
      acp: acp.service,
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", STATE_LOST);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(spawnSession).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("surfaces an honest failure when the respawn spawn throws", async () => {
    const session = makeSession({
      metadata: {
        label: "fix-bug-42",
        roomId: ROOM,
        worldId: WORLD,
        userId: USER,
        messageId: PARENT_MSG,
        source: "telegram",
        initialTask: "Fix the failing test in foo.ts",
      },
    });
    const acp = makeAcpService(session);
    const { runtime, handleMessage, spawnSession } = makeRuntime({
      acp: acp.service,
    });
    spawnSession.mockRejectedValueOnce(new Error("no slots"));
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", STATE_LOST);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("caps respawns per lineage and posts exactly one terminal failure", async () => {
    // A flapping task lineage (each crash respawns a new session that also
    // crashes) must not respawn unbounded. Cap is 3; the 4th state_lost for
    // the lineage reports one honest terminal failure, and any further ones
    // are suppressed.
    const ids = [
      "10000000-0000-0000-0000-000000000001",
      "10000000-0000-0000-0000-000000000002",
      "10000000-0000-0000-0000-000000000003",
      "10000000-0000-0000-0000-000000000004",
      "10000000-0000-0000-0000-000000000005",
    ];
    const sessions = new Map(
      ids.map((id) => [
        id,
        makeSession({
          id,
          metadata: {
            label: "fix-bug-42",
            roomId: ROOM,
            worldId: WORLD,
            userId: USER,
            messageId: PARENT_MSG, // shared origin → shared respawn lineage
            source: "telegram",
            initialTask: "Fix the failing test in foo.ts",
          },
        }),
      ]),
    );
    const captured: CapturedHandler = {};
    const service = {
      onSessionEvent: vi.fn((handler: typeof captured.fn) => {
        captured.fn = handler;
        return () => {
          captured.fn = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
      listSessions: vi.fn(async () => [...sessions.values()]),
      stopSession: vi.fn(async () => {}),
    };
    const { runtime, handleMessage, spawnSession } = makeRuntime({
      acp: service,
    });
    await SubAgentRouter.start(runtime);

    for (const id of ids) {
      captured.fn?.(id, "error", STATE_LOST);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }

    // 3 under-cap respawns (silent), then exactly one terminal failure post.
    expect(spawnSession).toHaveBeenCalledTimes(3);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    const metadata = posted?.content?.metadata as Record<string, unknown>;
    expect(metadata?.subAgentEvent).toBe("state_lost_exhausted");
    expect(metadata?.subAgentStatus).toBe("failed");
    expect(posted?.content?.text).toContain("could not be recovered");
  });
});

describe("SubAgentRouter parent-agent dispatch", () => {
  let session: SessionInfo;
  let acp: ReturnType<typeof makeAcpService>;

  beforeEach(() => {
    session = makeSession();
    acp = makeAcpService(session);
  });

  it("bridges a complete USE_SKILL parent-agent directive to the broker and replies", async () => {
    const { runtime } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);
    try {
      // list-cloud-commands needs no network/cloud key — the real broker
      // renders the static catalog — so this exercises the full
      // message -> extract -> broker -> sendToSession path.
      acp.emit(SESSION_ID, "message", {
        text: 'USE_SKILL parent-agent {"mode":"list-cloud-commands"}',
      });
      await new Promise((r) => setImmediate(r));

      expect(acp.service.sendToSession).toHaveBeenCalledTimes(1);
      const [sid, reply] = acp.service.sendToSession.mock.calls[0] as [
        string,
        string,
      ];
      expect(sid).toBe(SESSION_ID);
      expect(reply.toLowerCase()).toContain("domains.buy");
    } finally {
      await router.stop();
    }
  });

  it("reassembles a directive split across message chunks", async () => {
    const { runtime } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);
    try {
      for (const chunk of [
        "Working on it. USE_SKILL parent-",
        'agent {"mode":"list-cloud',
        '-commands"}\ndone',
      ]) {
        acp.emit(SESSION_ID, "message", { text: chunk });
      }
      await new Promise((r) => setImmediate(r));
      expect(acp.service.sendToSession).toHaveBeenCalledTimes(1);
    } finally {
      await router.stop();
    }
  });

  it("ignores ordinary output without the marker", async () => {
    const { runtime } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);
    try {
      acp.emit(SESSION_ID, "message", {
        text: "Just building the app, no broker needed here.",
      });
      await new Promise((r) => setImmediate(r));
      expect(acp.service.sendToSession).not.toHaveBeenCalled();
    } finally {
      await router.stop();
    }
  });

  it("stops dispatching after the per-session round-trip cap", async () => {
    const { runtime } = makeRuntime({
      acp: acp.service,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "1" },
    });
    const router = await SubAgentRouter.start(runtime);
    try {
      acp.emit(SESSION_ID, "message", {
        text: 'USE_SKILL parent-agent {"mode":"list-cloud-commands"}',
      });
      await new Promise((r) => setImmediate(r));
      acp.emit(SESSION_ID, "message", {
        text: 'USE_SKILL parent-agent {"mode":"list-cloud-commands"}',
      });
      await new Promise((r) => setImmediate(r));

      expect(acp.service.sendToSession).toHaveBeenCalledTimes(2);
      const second = acp.service.sendToSession.mock.calls[1] as [
        string,
        string,
      ];
      expect(second[1]).toContain("round-trip cap");
    } finally {
      await router.stop();
    }
  });
});
