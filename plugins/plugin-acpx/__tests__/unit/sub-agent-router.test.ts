import type { Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "ffffffff-1111-2222-3333-444444444444";
const PARENT_MSG = "99999999-8888-7777-6666-555555555555";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

interface CapturedHandler {
  fn?: (sessionId: string, event: string, data: unknown) => void;
}

function makeAcpService(session: SessionInfo): {
  service: {
    onSessionEvent: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
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
    getSession: vi.fn(async (id: string) =>
      id === session.id ? session : null,
    ),
    listSessions: vi.fn(async () => [session]),
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
    (runtime: unknown, memory: Memory) => Promise<unknown>
  >(async () => ({}));
  const createMemory = vi.fn(async () => undefined);
  const emitEvent = vi.fn<
    (name: string, payload: { source: string }) => Promise<void>
  >(async () => undefined);
  const runtime = {
    agentId: opts.agentId ?? "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn(() => opts.acp ?? null),
    getSetting: vi.fn((k: string) => opts.setting?.[k]),
    createMemory,
    emitEvent,
    messageService: { handleMessage },
  } as never;
  return { runtime, handleMessage, createMemory, emitEvent };
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
  });

  it("posts a synthetic memory back to the origin room on task_complete", async () => {
    const { runtime, handleMessage, createMemory } = makeRuntime({
      acp: acp.service,
    });
    const router = await SubAgentRouter.start(runtime);
    expect(acp.service.onSessionEvent).toHaveBeenCalledTimes(1);

    acp.emit(SESSION_ID, "task_complete", {
      response: "PR opened: github.com/foo/bar/pull/42",
      durationMs: 1234,
    });
    await new Promise((r) => setImmediate(r));

    expect(createMemory).toHaveBeenCalledTimes(1);
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
    expect(metadata?.originUserId).toBe(USER);
    expect(typeof posted.content?.text).toBe("string");
    expect(posted.content?.text).toContain("PR opened");

    await router.stop();
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
});
