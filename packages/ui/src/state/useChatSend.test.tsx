// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import { CLOUD_HANDOFF_PHASE_EVENT } from "../events";
import type { LoadConversationMessagesResult } from "./internal";
import { type UseChatSendDeps, useChatSend } from "./useChatSend";

const SHARED_BASE = "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123";
const DEDICATED_BASE = "https://agent-456.elizacloud.ai";

function dispatchHandoffPhase(phase: string): void {
  window.dispatchEvent(
    new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
      detail: { agentId: "agent-123", phase },
    }),
  );
}

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    renameConversation: vi.fn(() => Promise.resolve()),
    getBaseUrl: vi.fn(() => ""),
  },
}));

vi.mock("../api", () => ({
  client: mocks.client,
}));

// Stub Capacitor so the REAL `../api/client-cloud` (imported by useChatSend)
// loads cleanly under jsdom. We deliberately do NOT mock client-cloud: these
// freeze tests must exercise the production `isDirectCloudSharedAgentBase`
// classifier, not a hand-copied regex that can silently drift from it.
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function makeDeps(
  overrides: {
    activeConversationId?: string | null;
    conversations?: Conversation[];
  } = {},
): UseChatSendDeps {
  const conversationsRef = {
    current: overrides.conversations ?? [],
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: [],
  } as MutableRefObject<ConversationMessage[]>;
  const chatPendingImagesRef = {
    current: [],
  } as MutableRefObject<ImageAttachment[]>;

  const setConversations: UseChatSendDeps["setConversations"] = (value) => {
    conversationsRef.current =
      typeof value === "function" ? value(conversationsRef.current) : value;
  };
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  };

  return {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: overrides.activeConversationId ?? null,
    ptySessionsRef: {
      current: [],
    } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: {
      current: overrides.activeConversationId ?? null,
    } as MutableRefObject<string | null>,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: {
      current: null,
    } as MutableRefObject<AbortController | null>,
    chatSendBusyRef: {
      current: false,
    } as MutableRefObject<boolean>,
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
}

function mockStreamingUntilAbort(started: Deferred<void>) {
  mocks.client.sendConversationMessageStream.mockImplementation(
    (
      _id: string,
      _text: string,
      _onToken: (token: string, accumulatedText?: string) => void,
      _channelType: string,
      signal?: AbortSignal,
    ) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    },
  );
}

describe("useChatSend stop handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.abortConversationTurn.mockResolvedValue({
      aborted: true,
      roomId: "room-1",
      reason: "ui-chat-stop",
    });
    mocks.client.stopCodingAgent.mockResolvedValue(undefined);
  });

  it("aborts the backend turn using the latest conversation room id when Stop is clicked", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-1",
      "ui-chat-stop",
    );
  });

  it("aborts a newly created conversation by the room id returned from creation", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-new",
      "ui-chat-stop",
    );
  });

  it("does NOT surface an error notice when the send is aborted by the user", async () => {
    // A user-initiated stop rejects the stream with AbortError. The send catch
    // has a dedicated abort branch (drop the empty assistant placeholder, return)
    // that must NOT fall through to the error-toast path — a Stop is intentional,
    // not a failure.
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    // The abort path ran (server turn aborted) but no error notice was shown.
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });
});

function http404(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function mockStream404() {
  mocks.client.sendConversationMessageStream.mockRejectedValue(http404());
}

describe("useChatSend 404 recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("keeps the user message + notifies when the agent is gone (cloud base createConversation 404)", async () => {
    // Regression: on a cloud agent base a send-404 fell through to recreate the
    // conversation, which ALSO 404s when the agent is deleted/unreachable — the
    // old code silently dropped the user's message. Now it surfaces a notice and
    // keeps the user bubble.
    mockStream404();
    mocks.client.createConversation.mockRejectedValue(http404());
    mocks.client.getBaseUrl.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("no longer reachable"),
      "error",
      expect.any(Number),
    );
    // The user message is preserved (only the empty assistant placeholder is
    // dropped).
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });

  it("recreates the conversation and replays when only the conversation was deleted", async () => {
    // The normal recoverable case: the conversation row was deleted but the
    // agent is fine. createConversation succeeds, the message is replayed.
    mockStream404();
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    mocks.client.sendConversationMessage.mockResolvedValue({ text: "hi back" });
    mocks.client.getBaseUrl.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).not.toHaveBeenCalled();
    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.client.sendConversationMessage).toHaveBeenCalledTimes(1);
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && m.text === "hi back"),
    ).toBe(true);
  });

  it("does NOT notify on a non-cloud base when createConversation 404s (preserves prior behaviour)", async () => {
    mockStream404();
    mocks.client.createConversation.mockRejectedValue(http404());
    mocks.client.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).not.toHaveBeenCalled();
    // Prior behaviour: the empty assistant placeholder is dropped.
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });
});

describe("useChatSend always streams (#9174)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  it("uses the streaming endpoint on the happy path and never the non-streaming one", async () => {
    const tokens: Array<[string, string]> = [];
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        // Cloud + local both drive the UI through this same callback.
        onToken("Hello", "Hello");
        onToken(" world", "Hello world");
        tokens.push(["Hello", " world"]);
        return { text: "Hello world", completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // Happy path streams.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    // The non-streaming endpoint is reserved for 404 recovery only.
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
    // Streaming context is active by default — the first-token signal fired as
    // tokens arrived through onToken.
    expect(deps.setChatFirstTokenReceived).toHaveBeenCalledWith(true);
    // The streaming callback actually received incremental tokens.
    expect(tokens).toEqual([["Hello", " world"]]);
  });
});

function httpStatusError(status: number, message = "Error"): Error {
  return Object.assign(new Error(message), { status });
}

describe("useChatSend non-404 send failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces a notice + keeps the user message on a transient (non-404) send failure", async () => {
    // Regression: non-404 send failures (network drop mid-stream / 5xx) fell to
    // a silent else branch that only reloaded — the typing dots vanished with no
    // error, reading as "my message was lost". Now it drops only the empty
    // assistant placeholder, keeps the user bubble, and surfaces a notice.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Service Unavailable"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("are you there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("waking up"),
      "error",
      expect.any(Number),
    );
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "are you there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });

  it("does not reload (which could re-fail) on an auth-failure send error, and notifies", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(401, "Unauthorized"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("sign in again"),
      "error",
      expect.any(Number),
    );
    // Auth failures skip the reconcile reload (it would just fail again).
    expect(deps.loadConversationMessages).not.toHaveBeenCalled();
  });
});

describe("useChatSend freeze-on-shared during handoff (PR2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue(SHARED_BASE);
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  it("queues a message sent during the handoff window and delivers it to the dedicated agent after switch (not lost, not sent to shared)", async () => {
    // The bug this proves we fixed: while the handoff is migrating the user is
    // still on the SHARED agent, whose transcript was already snapshotted. The
    // dedicated import is skip-all idempotent, so a message that reaches the
    // shared history after the snapshot is silently lost. The freeze must hold
    // the message off the shared agent and deliver it to the dedicated once the
    // client has switched.
    const basesSeenAtSend: string[] = [];
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      basesSeenAtSend.push(mocks.client.getBaseUrl());
      return { text: "ack", completed: true };
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    // Handoff starts: the window opens.
    act(() => dispatchHandoffPhase("migrating"));

    // The user fires a message DURING the window. sendChatText resolves only
    // once the message is actually delivered, so we don't await it here — it
    // must stay pending (queued) until the switch settles.
    let sendSettled = false;
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current
        .sendChatText("during handoff", { conversationId: "conv-1" })
        .then(() => {
          sendSettled = true;
        });
      // Give the queued flush a chance to (not) run.
      await Promise.resolve();
    });

    // GUARANTEE 1: nothing was dispatched to the shared agent — the message did
    // not reach the post-snapshot shared history, so it can't be lost.
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(sendSettled).toBe(false);

    // The switch completes: onSwitch re-points the live client at the dedicated
    // container BEFORE the `switched` phase is dispatched (mirrors the real
    // handoff ordering), then the phase fires and unfreezes the queue.
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    await act(async () => {
      dispatchHandoffPhase("switched");
      await sendPromise;
    });

    // GUARANTEE 2: the queued message was delivered exactly once, and only after
    // the client pointed at the dedicated container.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const [convIdArg, textArg] =
      mocks.client.sendConversationMessageStream.mock.calls[0];
    expect(convIdArg).toBe("conv-1");
    expect(textArg).toBe("during handoff");
    expect(basesSeenAtSend).toEqual([DEDICATED_BASE]);
    expect(sendSettled).toBe(true);
  });

  it("flushes the queue to the shared agent (no message lost) when the handoff times out", async () => {
    // Fallback path: the dedicated container never became ready. No switch
    // happened and no snapshot landed, so the user safely stays on the shared
    // agent — the queued message must still be delivered there, never dropped.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "ack",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    act(() => dispatchHandoffPhase("migrating"));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("during handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    // Handoff gives up — unfreeze and drain to the (still-active) shared agent.
    await act(async () => {
      dispatchHandoffPhase("timed-out");
      await sendPromise;
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const [convIdArg, textArg] =
      mocks.client.sendConversationMessageStream.mock.calls[0];
    expect(convIdArg).toBe("conv-1");
    expect(textArg).toBe("during handoff");
  });

  it("does not freeze when no handoff is in flight — sends dispatch inline (flag-off parity)", async () => {
    // With `preferSharedCloudTier` off no `migrating` phase ever fires, so the
    // freeze flag stays false and the queue drains immediately, exactly as
    // before this change.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "ack",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
  });
});
