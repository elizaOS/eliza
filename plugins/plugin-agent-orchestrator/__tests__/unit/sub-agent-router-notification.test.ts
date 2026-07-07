/**
 * SubAgentRouter notification tests drive real session events through the bound
 * AcpService handler with a mocked notification service. They assert that a
 * terminal task_complete event emits exactly one agent notification with the
 * orchestrator source, deep link, session group key, and session metadata.
 */
//   - notify is NOT called for error / blocked / QUESTION_FOR_TASK_CREATOR /
//     AGENT_COORDINATION / streaming (agent_message_chunk / tool_running) events
//
// Everything is deterministic: no network (notify is mocked, no URLs in the
// completion text so the URL-reachability verifier never fetches), no real
// timers — we only await microtask flushes (setImmediate) like the sibling
// sub-agent-router.test.ts.

import type { Content, HandlerCallback, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const WORKTREE_ROOM = "22222222-3333-4444-5555-666666666666";
const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "ffffffff-1111-2222-3333-444444444444";
const PARENT_MSG = "99999999-8888-7777-6666-555555555555";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

// Mirrors ServiceType.NOTIFICATION ("notification") from @elizaos/core; the
// router resolves the notifier via getService(ServiceType.NOTIFICATION).
const NOTIFICATION_SERVICE_TYPE = "notification";
const ACP_SERVICE_TYPE = "ACP_SUBPROCESS_SERVICE";

interface CapturedHandler {
  fn?: (sessionId: string, event: string, data: unknown) => void;
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

// Build a runtime whose getService routes the NOTIFICATION service to a
// distinct mock while every other type (ACP) resolves to the acp service —
// the production getNotifier() asks specifically for ServiceType.NOTIFICATION,
// so a mock that returns the acp for ALL types would never exercise the
// notify path.
function makeRuntime(opts: {
  acp: unknown;
  notify?: ReturnType<typeof vi.fn>;
  notificationService?: unknown;
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
  const notify = opts.notify ?? vi.fn(async () => undefined);
  // `notificationService` lets a test override the shape (e.g. omit notify or
  // return null) to prove the router degrades gracefully.
  const notificationService =
    "notificationService" in opts ? opts.notificationService : { notify };
  const getService = vi.fn((type: string) => {
    if (type === NOTIFICATION_SERVICE_TYPE) return notificationService ?? null;
    if (type === ACP_SERVICE_TYPE) return acpService ?? null;
    return acpService ?? null;
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService,
    getSetting: vi.fn(() => undefined),
    createMemory: vi.fn(async () => undefined),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
    sendMessageToTarget,
    messageService: { handleMessage },
  } as never;
  return { runtime, handleMessage, notify, getService, spawnSession };
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

// Flush the microtask queue twice: handleEvent awaits several times before the
// notify call site, and notify itself is fire-and-forget (`void ...notify()`).
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("SubAgentRouter notification emission", () => {
  let session: SessionInfo;
  let acp: ReturnType<typeof makeAcpService>;

  beforeEach(() => {
    session = makeSession();
    acp = makeAcpService(session);
  });

  it("emits exactly one AgentNotification on task_complete with the orchestrator routing fields", async () => {
    const notify = vi.fn(async () => undefined);
    const { runtime, getService } = makeRuntime({ acp: acp.service, notify });
    const router = await SubAgentRouter.start(runtime);

    // No URLs in the completion text → the reachability verifier never fetches,
    // so this stays a pure, network-free unit test.
    acp.emit(SESSION_ID, "task_complete", {
      response: "PR opened and merged.",
    });
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0]?.[0] as Record<string, unknown>;
    if (!arg) throw new Error("expected notify to receive a payload");

    // Category/source/deepLink are the load-bearing routing fields a UI uses to
    // file, badge, and navigate the notification.
    expect(arg.category).toBe("agent");
    expect(arg.source).toBe("orchestrator");
    expect(arg.deepLink).toBe("/orchestrator");

    // groupKey collapses repeated notices for one task — it must include the
    // session id so distinct sessions don't share a group.
    expect(arg.groupKey).toBe(`orchestrator:${SESSION_ID}`);
    expect(String(arg.groupKey)).toContain(SESSION_ID);

    // The title surfaces the task label; the body previews the result.
    expect(arg.title).toContain("fix-bug-42");
    expect(typeof arg.body).toBe("string");
    expect(arg.body as string).toContain("PR opened");

    // The structured data payload carries the session id + label + origin source
    // so the UI can re-open the exact task/thread.
    const data = arg.data as Record<string, unknown>;
    expect(data.sessionId).toBe(SESSION_ID);
    expect(data.label).toBe("fix-bug-42");
    expect(data.originSource).toBe("telegram");

    // The notifier was resolved via the NOTIFICATION service type, not the ACP
    // service type — a regression that swapped them would fail here.
    expect(getService).toHaveBeenCalledWith(NOTIFICATION_SERVICE_TYPE);

    await router.stop();
  });

  it("does NOT emit a notification for an error event", async () => {
    const notify = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ acp: acp.service, notify });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "acpx exited with code 137 (oom)",
    });
    await flush();

    expect(notify).not.toHaveBeenCalled();
    await router.stop();
  });

  it("does NOT emit a notification for a blocked event", async () => {
    const notify = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ acp: acp.service, notify });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "blocked", {
      message: "sub-agent is blocked and waiting for input",
    });
    await flush();

    expect(notify).not.toHaveBeenCalled();
    await router.stop();
  });

  it("does NOT emit a notification for QUESTION_FOR_TASK_CREATOR or AGENT_COORDINATION", async () => {
    // These are injected (non-streaming) events, but they are not terminal
    // completions — they must not raise a "task finished" notification.
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
    const notify = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ acp: acp.service, notify });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "QUESTION_FOR_TASK_CREATOR", {
      question: "Which branch should I target?",
    });
    await flush();
    acp.emit(SESSION_ID, "AGENT_COORDINATION", {
      message: "I am touching router tests.",
    });
    await flush();

    expect(notify).not.toHaveBeenCalled();
    await router.stop();
  });

  it("does NOT emit a notification for streaming / non-terminal events", async () => {
    const notify = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ acp: acp.service, notify });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "agent_message_chunk", { delta: "thinking…" });
    acp.emit(SESSION_ID, "tool_running", { tool: "Bash" });
    acp.emit(SESSION_ID, "ready", {});
    acp.emit(SESSION_ID, "message", { text: "streamed output" });
    await flush();

    expect(notify).not.toHaveBeenCalled();
    await router.stop();
  });

  it("still posts the synthetic memory when no NOTIFICATION service is registered", async () => {
    // The notifier is optional — getNotifier returns null when the service is
    // absent. A missing notifier must never break the core routing path.
    const { runtime, handleMessage } = makeRuntime({
      acp: acp.service,
      notificationService: null,
    });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "all done." });
    await flush();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    await router.stop();
  });

  it("does not throw and still routes when notify() rejects", async () => {
    // The emit is fire-and-forget with a .catch — a rejecting notifier must not
    // abort delivery of the synthetic completion memory.
    const notify = vi.fn(async () => {
      throw new Error("notification backend offline");
    });
    const { runtime, handleMessage } = makeRuntime({
      acp: acp.service,
      notify,
    });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "done despite outage." });
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    await router.stop();
  });
});
