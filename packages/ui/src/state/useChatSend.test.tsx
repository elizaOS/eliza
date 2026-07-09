// @vitest-environment jsdom

/**
 * Core coverage of the chat send lifecycle (`useChatSend`): Stop/abort
 * handling, 404 conversation-gone recovery, always-streaming delivery,
 * transient send-failure notices, and the cloud shared→dedicated handoff queue.
 * Real hook under jsdom with a fake API client — deterministic, no live model
 * or network.
 */
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatToolCallEvent,
  ChatTurnStatus,
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import {
  __resetNetworkStatusForTests,
  StreamGenerationError,
} from "../api/client-base";
import { APP_RESUME_EVENT, CLOUD_HANDOFF_PHASE_EVENT } from "../events";
import type { LoadConversationMessagesResult } from "./internal";
import {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  isRetryableSendError,
  UNDELIVERED_TURN_NOTICE,
  type UseChatSendDeps,
  useChatSend,
} from "./useChatSend";

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
    truncateConversationMessages: vi.fn(() => Promise.resolve()),
    deleteConversationMessage: vi.fn(() =>
      Promise.resolve({ ok: true, deletedCount: 1 }),
    ),
    getBaseUrl: vi.fn(() => ""),
    // Real client exposes onWsEvent(type, handler) => unsubscribe; the retry
    // path subscribes to "ws-reconnected" through it. Default no-op unsubscribe.
    onWsEvent: vi.fn(() => () => {}),
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
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: {
      current: overrides.activeConversationId ?? null,
    } as MutableRefObject<string | null>,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef,
    chatReplyTargetRef: { current: null },
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

  it("paints the accepted turn before cold conversation creation finishes", async () => {
    const creation = deferred<{ conversation: Conversation }>();
    mocks.client.createConversation.mockReturnValue(creation.promise);
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Hi there",
      completed: true,
    });
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "" },
    ]);

    await act(async () => {
      creation.resolve({
        conversation: conversation("conv-new", "room-new"),
      });
      await sendPromise;
    });
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

  it("keeps a locally-committed partial reply after a STOP whose reload lacks it", async () => {
    // STOP mid-stream resolves the stream with the partial + completed:false.
    // The server never persisted the partial, so the post-turn history reload
    // full-replaces local state with ONLY the persisted user turn. The partial
    // the user was watching must survive that reload — re-attached as an
    // interrupted assistant turn.
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("Here is the par", "Here is the par");
        return { text: "Here is the par", completed: false };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // Server full-replace reload: only the persisted user turn survives (the
    // stopped assistant reply was never written server-side). A real persisted
    // turn carries an epoch-ms timestamp at ~send time — required for the
    // #11670 eviction guard to recognize it as this send.
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "server-user-1",
          role: "user",
          text: "hello",
          timestamp: Date.now(),
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const assistantMessages = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe("Here is the par");
    expect(assistantMessages[0].interrupted).toBe(true);
  });

  it("does NOT duplicate the partial when the server persisted the stopped reply", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("Here is the par", "Here is the par");
        return { text: "Here is the par", completed: false };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // Server DID persist the (truncated) reply — the reload carries it, so the
    // partial must not be re-attached a second time. Realistic epoch-ms
    // timestamps (see above).
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "server-user-1",
          role: "user",
          text: "hello",
          timestamp: Date.now(),
        },
        {
          id: "server-asst-1",
          role: "assistant",
          text: "Here is the par",
          timestamp: Date.now(),
          interrupted: true,
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const assistantMessages = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("server-asst-1");
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

  it("recreates the conversation and replays as a token STREAM when only the conversation was deleted", async () => {
    // The normal recoverable case: the conversation row was deleted but the
    // agent is fine. createConversation succeeds, and the message is REPLAYED
    // through the streaming endpoint (not the non-streaming one) so the reply
    // tokens in rather than popping in all at once (#10231).
    const replayTokens: Array<[string, string]> = [];
    mocks.client.sendConversationMessageStream
      .mockRejectedValueOnce(http404())
      .mockImplementationOnce(
        async (
          _id: string,
          _text: string,
          onToken: (token: string, accumulatedText?: string) => void,
        ) => {
          onToken("hi", "hi");
          onToken(" back", "hi back");
          replayTokens.push(["hi", " back"]);
          return { text: "hi back", completed: true };
        },
      );
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
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
    // Original send (404) + streaming replay = two stream calls; the
    // non-streaming endpoint is never used.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
    // The replay actually streamed tokens.
    expect(replayTokens).toEqual([["hi", " back"]]);
    expect(deps.setChatFirstTokenReceived).toHaveBeenCalledWith(true);
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && m.text === "hi back"),
    ).toBe(true);
  });

  it("surfaces a send-failure notice on a non-cloud base when createConversation 404s (#12267: a silent return read as a lost message)", async () => {
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

    // The recovery could not produce a conversation to replay into: the user
    // must see the failure instead of a message that silently vanished.
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringMatching(/didn't go through/i),
      "error",
      8_000,
    );
    // The stuck empty assistant placeholder is still dropped.
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
    // The non-streaming endpoint is never used — even 404 recovery streams now
    // (#10231).
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
    // Streaming context is active by default — the first-token signal fired as
    // tokens arrived through onToken.
    expect(deps.setChatFirstTokenReceived).toHaveBeenCalledWith(true);
    // The streaming callback actually received incremental tokens.
    expect(tokens).toEqual([["Hello", " world"]]);
  });
});

describe("useChatSend streaming-frame coalescing (text + status + tool)", () => {
  let rafQueue: FrameRequestCallback[];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafQueue[id - 1] = () => {};
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf(): number {
    const q = rafQueue;
    rafQueue = [];
    act(() => {
      for (const cb of q) cb(0);
    });
    return q.length;
  }

  it("parks token+status+tool from one SSE burst into a SINGLE frame, committing all three together", async () => {
    // Capture the per-event callbacks from a stream that stays pending so the
    // rAF frame can be observed BEFORE the terminal synchronous flush.
    let onTokenCb!: (t: string, a?: string) => void;
    let onStatusCb!: (s: ChatTurnStatus) => void;
    let onToolCb!: (e: ChatToolCallEvent) => void;
    let resolveStream!: (v: { text: string; completed: boolean }) => void;
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
        onTool: (e: ChatToolCallEvent) => void,
      ) => {
        onTokenCb = onToken;
        onStatusCb = onStatus;
        onToolCb = onTool;
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      // Let the send reach the streaming call and register the callbacks.
      await Promise.resolve();
      await Promise.resolve();
    });

    // One SSE burst: a token, a status phase, and a tool call all arrive in the
    // same tick — before any frame runs.
    act(() => {
      onTokenCb("Search", "Search");
      onStatusCb({ kind: "running_tool", toolName: "web_search" });
      onToolCb({ phase: "call", callId: "c1", toolName: "web_search" });
    });

    // Nothing has committed yet: no text on the assistant turn, no status set,
    // no tool rows — all three are parked for the single scheduled frame.
    const assistantBefore = deps.conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    );
    expect(assistantBefore?.text ?? "").toBe("");
    expect(assistantBefore?.toolEvents ?? []).toHaveLength(0);
    expect(setStatusSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "running_tool" }),
    );

    // Exactly one frame was scheduled for the whole burst; flushing it commits
    // text, tool row, and status together.
    const framesRun = flushRaf();
    expect(framesRun).toBe(1);

    const assistantAfter = deps.conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    );
    expect(assistantAfter?.text).toBe("Search");
    expect(assistantAfter?.toolEvents ?? []).toHaveLength(1);
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "running_tool", toolName: "web_search" }),
    );

    // Terminal transition: resolve the stream and drain.
    await act(async () => {
      resolveStream({ text: "Search done", completed: true });
      await sendPromise;
    });
  });

  it("flushes parked tool/status synchronously on the terminal transition even if no frame ran", async () => {
    // A tool event + status arrive, then the stream resolves in the SAME tick
    // before any rAF fires. The synchronous flushStreamingText() before the
    // terminal modification must still commit them (no lost tool row / status).
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
        onTool: (e: ChatToolCallEvent) => void,
      ) => {
        onToken("partial", "partial");
        onStatus({ kind: "running_tool", toolName: "web_search" });
        onTool({ phase: "call", callId: "c1", toolName: "web_search" });
        // No rAF flush between here and return — the terminal path must flush.
        return { text: "partial done", completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // The tool row survived to the final thread (merged before the reload's
    // no-op) and the status phase was committed at least once.
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "running_tool" }),
    );
    // Status is cleared to null when the turn settles.
    expect(setStatusSpy).toHaveBeenLastCalledWith(null);
  });

  it("settles the visible reply before a slow post-turn history reload", async () => {
    const historyReload = deferred<LoadConversationMessagesResult>();
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
      ) => {
        onStatus({ kind: "running_action", actionName: "REPLY" });
        onToken("Done", "Done");
        return { text: "Done", completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.loadConversationMessages = vi.fn(() => historyReload.promise);
    const setSendingSpy = deps.setChatSending as ReturnType<typeof vi.fn>;
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
    });

    await vi.waitFor(() => {
      expect(deps.loadConversationMessages).toHaveBeenCalledWith("conv-1");
    });

    // The response text is already visible, so history reconciliation must not
    // keep the turn spinner/status alive while its request is still pending.
    expect(setStatusSpy).toHaveBeenLastCalledWith(null);
    expect(setSendingSpy).toHaveBeenLastCalledWith(false);

    await act(async () => {
      historyReload.resolve({ ok: true });
      await sendPromise;
    });
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

  it("distinguishes a first-token timeout from a network drop in the notice copy", async () => {
    // A timeout means the agent WAS reached but did not respond in time, so
    // "check your connection" is the wrong remedy. Timeout → slow-response copy;
    // a genuine network drop keeps the connection copy.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("Request timed out"), { kind: "timeout" }),
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

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("took too long"),
      "error",
      expect.any(Number),
    );
    // Must NOT show the misleading network/connection copy for a timeout.
    expect(deps.setActionNotice).not.toHaveBeenCalledWith(
      expect.stringContaining("check your connection"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps the connection copy for a genuine network drop (after the auto-retry exhausts)", async () => {
    // A network-kind drop now first auto-retries on reconnect (E2). When the
    // retry ALSO fails, the connection copy still surfaces — the copy contract
    // is unchanged, it just lands after the single auto-retry is spent. Use
    // fake timers so the reconnect-wait resolves instantly instead of hanging.
    vi.useFakeTimers();
    try {
      __resetNetworkStatusForTests();
      mocks.client.onWsEvent.mockImplementation(() => () => {});
      mocks.client.sendConversationMessageStream.mockRejectedValue(
        Object.assign(new Error("Failed to fetch"), { kind: "network" }),
      );

      const deps = makeDeps({
        activeConversationId: "conv-1",
        conversations: [conversation("conv-1", "room-1")],
      });
      const { result } = renderHook(() => useChatSend(deps));

      let sendPromise: Promise<void> | undefined;
      await act(async () => {
        sendPromise = result.current.sendChatText("hi", {
          conversationId: "conv-1",
        });
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        // Drive the reconnect edge → the single auto-retry fires and re-fails.
        document.dispatchEvent(new Event(APP_RESUME_EVENT));
        await vi.advanceTimersByTimeAsync(500);
        await sendPromise;
      });

      expect(deps.setActionNotice).toHaveBeenCalledWith(
        expect.stringContaining("check your connection"),
        "error",
        expect.any(Number),
      );
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
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

  it("re-checks the freeze mid-drain: a message queued behind an in-flight send when `migrating` fires is NOT drained to shared after the snapshot", async () => {
    // Regression for the in-flight-drain race: send A is already mid-`await`
    // when the handoff begins; the user then fires send B during the window.
    // B is enqueued behind A's still-running drain loop. When A resolves the
    // loop must NOT shift B and dispatch it to the (post-snapshot) SHARED agent
    // — it must re-check the freeze, break, and leave B for the post-switch
    // flush. Without the per-iteration freeze re-check, B leaks to shared and is
    // lost to the skip-all import.
    const basesSeenAtSend: string[] = [];
    let releaseA: (() => void) | undefined;
    const aInFlight = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let callCount = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      const index = callCount++;
      basesSeenAtSend.push(mocks.client.getBaseUrl());
      if (index === 0) await aInFlight; // A blocks until we release it
      return { text: "ack", completed: true };
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    // Send A starts on the SHARED base BEFORE the handoff — it is not frozen, so
    // it enters the drain loop and parks mid-await (the drain loop stays busy).
    let aPromise: Promise<void> | undefined;
    await act(async () => {
      aPromise = result.current.sendChatText("before handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    // Handoff begins while A is still in flight, then the user fires B.
    act(() => dispatchHandoffPhase("migrating"));
    let bPromise: Promise<void> | undefined;
    await act(async () => {
      bPromise = result.current.sendChatText("during handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    // Release A; the still-running drain loop must break on the freeze re-check
    // rather than draining B to shared.
    await act(async () => {
      releaseA?.();
      await aPromise;
      await Promise.resolve();
    });

    // GUARANTEE: B was NOT sent to shared — only A's send happened, on SHARED.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(basesSeenAtSend).toEqual([SHARED_BASE]);

    // Switch settles: the client repoints to the dedicated, the phase fires, and
    // B drains to the dedicated container exactly once.
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    await act(async () => {
      dispatchHandoffPhase("switched");
      await bPromise;
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    expect(basesSeenAtSend).toEqual([SHARED_BASE, DEDICATED_BASE]);
    const [, secondText] =
      mocks.client.sendConversationMessageStream.mock.calls[1];
    expect(secondText).toBe("during handoff");
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

describe("useChatSend retry re-runs the turn in place (no duplicate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
    mocks.client.truncateConversationMessages.mockResolvedValue(undefined);
  });

  function seedFailedTurn(deps: UseChatSendDeps): void {
    const seeded: ConversationMessage[] = [
      { id: "u1", role: "user", text: "hello", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "I'm having trouble reaching the model provider.",
        timestamp: 2,
        failureKind: "provider_issue",
      },
    ];
    deps.conversationMessagesRef.current = seeded;
  }

  it("truncates from the user message (inclusive) and resends, leaving exactly one user turn", async () => {
    // Regression: the old retry only dropped the failed assistant bubble in
    // memory and resent, producing [Q, fail, Q-dup, new]. The fix mirrors
    // handleChatEdit — truncate [Q, fail] server-side, then re-run Q in place.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "recovered reply",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    seedFailedTurn(deps);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("a1");
    });

    // The turn was truncated from the user message inclusive, in place.
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledTimes(1);
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
      "conv-1",
      "u1",
      { inclusive: true },
    );
    // The text was resent once (re-run), not as a brand-new extra turn.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    // No duplicate user message: exactly one "hello" user turn remains, and the
    // failed assistant bubble (a1) is gone.
    const remaining = deps.conversationMessagesRef.current;
    const userHellos = remaining.filter(
      (m) => m.role === "user" && m.text === "hello",
    );
    expect(userHellos).toHaveLength(1);
    expect(remaining.some((m) => m.id === "a1")).toBe(false);
  });

  it("falls back to in-memory resend for an optimistic (temp-) user turn", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "recovered reply",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // An optimistic user turn whose server id hasn't landed yet — not safe to
    // truncate server-side, so retry drops the failed bubble in memory + resends.
    deps.conversationMessagesRef.current = [
      { id: "temp-u1", role: "user", text: "hello", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "I'm having trouble reaching the model provider.",
        timestamp: 2,
        failureKind: "provider_issue",
      },
    ];
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("a1");
    });

    // temp- user id → cannot truncate; resend still fires.
    expect(mocks.client.truncateConversationMessages).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend empty-reply failure surfacing (#10231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces a failureKind gate (not a silent drop) when the streamed terminal reply is empty", async () => {
    // Regression: the empty-text terminal handler dropped any empty reply
    // unconditionally, so an empty-text + failureKind response (e.g. the
    // "Connect a provider" gate) vanished with no error. It must stamp the
    // failureKind onto the assistant turn instead.
    mocks.client.sendConversationMessageStream.mockImplementation(async () => ({
      text: "",
      completed: true,
      failureKind: "no_provider",
    }));

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistant.length).toBe(1);
    expect(assistant[0]?.failureKind).toBe("no_provider");
  });

  it("still drops an empty terminal reply that carries no failureKind", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(async () => ({
      text: "",
      completed: true,
    }));

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistant.length).toBe(0);
  });
});

describe("buildSendFailureNotice (#10231)", () => {
  it("maps auth/rate/availability/kind failures to status-specific copy", () => {
    expect(buildSendFailureNotice({ status: 401 })).toContain(
      "session expired",
    );
    expect(buildSendFailureNotice({ status: 403 })).toContain(
      "session expired",
    );
    expect(buildSendFailureNotice({ status: 429 })).toContain("busy");
    expect(buildSendFailureNotice({ status: 503 })).toContain("waking up");
    expect(buildSendFailureNotice({ status: 502 })).toContain("waking up");
    expect(buildSendFailureNotice({ kind: "timeout" })).toContain(
      "took too long",
    );
    expect(buildSendFailureNotice({ kind: "network" })).toContain(
      "check your connection",
    );
  });

  it("falls back to a generic resend notice for an unknown failure (never empty)", () => {
    const notice = buildSendFailureNotice(new Error("boom"));
    expect(notice.length).toBeGreaterThan(0);
    expect(notice).toContain("resend");
  });

  it("surfaces the server's validation reason for a 4xx validation reject", () => {
    // Regression: a 400 (e.g. attachment too large / unsupported type) got the
    // generic "didn't go through — please resend" copy, which discards the only
    // information that lets the user fix the payload; resending unchanged fails
    // identically forever.
    const err = Object.assign(new Error("Attachment too large (max 5 MB)"), {
      status: 400,
      kind: "http",
    });
    const notice = buildSendFailureNotice(err);
    expect(notice).toContain("Attachment too large (max 5 MB)");
    expect(notice).not.toContain("didn't go through");
  });

  it("keeps the generic copy for a body-less 4xx and for 5xx server messages", () => {
    // No usable body → "HTTP 400" fallback message → generic copy.
    expect(
      buildSendFailureNotice(
        Object.assign(new Error("HTTP 400"), { status: 400, kind: "http" }),
      ),
    ).toContain("didn't go through");
    // 5xx bodies are internal noise, not user-actionable validation reasons.
    expect(
      buildSendFailureNotice(
        Object.assign(new Error("upstream connect error"), {
          status: 500,
          kind: "http",
        }),
      ),
    ).toContain("didn't go through");
  });
});

describe("getSendValidationFailureMessage", () => {
  it("extracts the message only for payload-validation statuses", () => {
    for (const status of [400, 413, 415, 422]) {
      expect(
        getSendValidationFailureMessage(
          Object.assign(new Error("bad payload"), { status }),
        ),
      ).toBe("bad payload");
    }
    for (const status of [401, 403, 404, 429, 500, 503]) {
      expect(
        getSendValidationFailureMessage(
          Object.assign(new Error("bad payload"), { status }),
        ),
      ).toBeNull();
    }
    expect(getSendValidationFailureMessage(new Error("no status"))).toBeNull();
  });
});

describe("useChatSend 4xx validation reject — honest notice + no-loss restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  function validationError(message: string): Error {
    return Object.assign(new Error(message), { status: 400, kind: "http" });
  }

  it("restores the text AND attachments to the composer and says why", async () => {
    // The destruction scenario: the composer was cleared at enqueue, the server
    // 400s before persisting, and the reconcile reload wipes the optimistic
    // bubble — without the restore the user's words are gone on a primary flow.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      validationError("Unsupported attachment type: image/heic"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    const images: ImageAttachment[] = [
      { data: "AAAA", mimeType: "image/heic", name: "photo.heic" },
    ];
    await act(async () => {
      await result.current.sendChatText("check out this photo", {
        conversationId: "conv-1",
        images,
      });
    });

    // Text back in the composer, attachments back in the pending tray.
    expect(deps.setChatInput).toHaveBeenCalledWith("check out this photo");
    expect(deps.setChatPendingImages).toHaveBeenCalledWith(images);
    // The notice carries the server's specific reason + the restore.
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    const [noticeText, tone] = (
      deps.setActionNotice as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(noticeText).toContain("Unsupported attachment type: image/heic");
    expect(noticeText).toContain("restored to the input");
    expect(tone).toBe("error");
    // The message never persisted server-side, so the thread reconciles (the
    // optimistic bubble is replaced by server truth; the draft lives in the
    // composer now, not the thread).
    expect(deps.loadConversationMessages).toHaveBeenCalledWith("conv-1");
  });

  it("restores just the text for a text-only validation reject", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      validationError("text is too long"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("a very long message", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setChatInput).toHaveBeenCalledWith("a very long message");
    expect(deps.setChatPendingImages).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Your message was restored to the input."),
      "error",
      expect.any(Number),
    );
  });

  it("does NOT restore the composer on a transient (5xx) failure", async () => {
    // Transient failures keep the user bubble in the thread (resend can
    // succeed); writing into the composer would clobber whatever the user
    // typed since.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Service Unavailable"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(deps.setChatInput).not.toHaveBeenCalled();
    expect(deps.setChatPendingImages).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend — user turn sent during agent warm-up is never evicted (#11670)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  /**
   * Make the mocked reload behave like the REAL loadConversationMessages: it
   * full-replaces local state with server truth. The default `{ ok: true }`
   * no-op mock is exactly why the eviction never showed up in this suite —
   * the production reload wipes the optimistic bubble when the server never
   * persisted the turn.
   */
  function mockServerTruthReload(
    deps: UseChatSendDeps,
    serverThread: { current: ConversationMessage[] },
  ): void {
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([...serverThread.current]);
      return { ok: true };
    });
  }

  function undeliveredTurns(deps: UseChatSendDeps): ConversationMessage[] {
    return deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant" && m.text === UNDELIVERED_TURN_NOTICE,
    );
  }

  it("restores the user bubble + a retryable failed turn when the warm-up 503 gate drops the send (the #11670 repro)", async () => {
    // The issue's exact path: the runtime-ready hold expires while the local
    // model warms up, the server 503s WITHOUT persisting the user message, and
    // the reconcile reload full-replaces the thread with an empty server truth
    // — on develop the user's bubble silently vanishes.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const remaining = deps.conversationMessagesRef.current;
    // The user's message is still visibly in the thread…
    expect(
      remaining.some(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toBe(true);
    // …followed by a retryable failed assistant turn (Retry chip), not dead air.
    const failed = undeliveredTurns(deps);
    expect(failed).toHaveLength(1);
    expect(failed[0].failureKind).toBe("provider_issue");
    // The status-specific notice still fires.
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("waking up"),
      "error",
      expect.any(Number),
    );
  });

  it("restores the user bubble when the stream completes empty and the server persisted nothing", async () => {
    // The quieter variant: the send "succeeds" (no throw, no failureKind) but
    // the runtime processed nothing and stored nothing — the reload wipes the
    // bubble with NO notice at all on develop.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });

  it("keeps optimistic attachments on the restored bubble", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("look at this", {
        conversationId: "conv-1",
        images: [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }],
      });
    });

    const restored = deps.conversationMessagesRef.current.find(
      (m) => m.role === "user" && m.text === "look at this",
    );
    expect(restored?.attachments).toHaveLength(1);
    expect(restored?.attachments?.[0].mimeType).toBe("image/png");
  });

  it("does NOT duplicate the turn when the server persisted it (silent agent turn stays as-is)", async () => {
    // A legitimately silent reply (agent chose not to answer): the user turn
    // IS in server truth, so the restore must no-op — no duplicate bubble, no
    // spurious failed turn.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = {
      current: [
        {
          id: "server-user-1",
          role: "user",
          text: "hello while warming",
          timestamp: Date.now(),
        } as ConversationMessage,
      ],
    };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const users = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "user" && m.text === "hello while warming",
    );
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("server-user-1");
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it("an identical user turn from an EARLIER exchange does not mask the eviction", async () => {
    // The user said "hi" five minutes ago (persisted), then says "hi" again
    // during warm-up. Matching by text alone would treat the old turn as this
    // send and silently drop the new one — the timestamp guard prevents that.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = {
      current: [
        {
          id: "server-user-old",
          role: "user",
          text: "hi",
          timestamp: Date.now() - 300_000,
        } as ConversationMessage,
        {
          id: "server-asst-old",
          role: "assistant",
          text: "hey!",
          timestamp: Date.now() - 299_000,
        } as ConversationMessage,
      ],
    };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const users = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "user" && m.text === "hi",
    );
    expect(users).toHaveLength(2);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });

  it("does NOT re-attach the bubble on a validation reject (the draft went back to the composer)", async () => {
    // 4xx validation rejects restore the draft to the composer; re-attaching
    // the bubble too would duplicate the content.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("text is too long"), {
        status: 400,
        kind: "http",
      }),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("a very long message", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setChatInput).toHaveBeenCalledWith("a very long message");
    expect(
      deps.conversationMessagesRef.current.some((m) => m.role === "user"),
    ).toBe(false);
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it("Retry on the restored turn re-delivers the message once the model is ready, without duplicating it", async () => {
    // Full loop: warm-up 503 → restored bubble + failed turn → model comes
    // online → one tap on Retry delivers the message and the thread settles to
    // exactly one copy of the turn.
    mocks.client.sendConversationMessageStream.mockRejectedValueOnce(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });
    const failedTurn = undeliveredTurns(deps)[0];
    expect(failedTurn).toBeDefined();

    // The model is ready now: the next send succeeds and the server persists
    // the turn, so the post-retry reload carries it.
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      serverThread.current = [
        {
          id: "server-user-1",
          role: "user",
          text: "hello while warming",
          timestamp: Date.now(),
        } as ConversationMessage,
        {
          id: "server-asst-1",
          role: "assistant",
          text: "hi! I'm awake now.",
          timestamp: Date.now(),
        } as ConversationMessage,
      ];
      return { text: "hi! I'm awake now.", completed: true };
    });

    await act(async () => {
      await result.current.handleChatRetry(failedTurn.id);
      // The fallback retry fires the resend without awaiting it — flush it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    const [, retriedText] =
      mocks.client.sendConversationMessageStream.mock.calls[1];
    expect(retriedText).toBe("hello while warming");
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.filter(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toHaveLength(1);
    expect(
      remaining.some(
        (m) => m.role === "assistant" && m.text === "hi! I'm awake now.",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it("sendActionMessage restores an evicted user turn the same way", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendActionMessage("run the report");
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (m) => m.role === "user" && m.text === "run the report",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });
});

describe("useChatSend — structured SSE error surfaces the gate (#10231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces the no_provider gate on the assistant turn, not a generic notice", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new StreamGenerationError({
        message: "no provider configured",
        failureKind: "no_provider",
      }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // The assistant turn carries the structured gate (renderer swaps in the
    // "Connect a provider" UI) — the empty placeholder is NOT dropped…
    const messages = deps.conversationMessagesRef.current;
    const assistant = messages.find((m) => m.role === "assistant") as
      | (ConversationMessage & { failureKind?: string })
      | undefined;
    expect(assistant?.failureKind).toBe("no_provider");
    // …and no generic error notice is shown (the gate replaces it).
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("surfaces a connect-account request from an error event", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new StreamGenerationError({
        message: "connect an account",
        // Minimal connect request — only its presence drives the block.
        accountConnect: {
          provider: "google",
          reason: "reconnect",
        } as never,
      }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    ) as (ConversationMessage & { accountConnect?: unknown }) | undefined;
    expect(assistant?.accountConnect).toBeTruthy();
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("still shows a generic notice for a plain (unstructured) stream error", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new Error("network blip"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // No structured gate → the existing generic-notice path is preserved.
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend — handleChatDelete persistent single-message delete (#13533)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.deleteConversationMessage.mockResolvedValue({
      ok: true,
      deletedCount: 1,
    });
  });

  function seedMessages(
    deps: UseChatSendDeps,
    messages: ConversationMessage[],
  ): void {
    deps.conversationMessagesRef.current = messages;
  }

  function userMsg(id: string, text = "hi"): ConversationMessage {
    return {
      id,
      role: "user",
      text,
      timestamp: 1,
    } as ConversationMessage;
  }

  it("optimistically removes the message and fires the server DELETE", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    seedMessages(deps, [userMsg("m-1"), userMsg("m-2"), userMsg("m-3")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-2");
    });

    expect(ok).toBe(true);
    expect(mocks.client.deleteConversationMessage).toHaveBeenCalledWith(
      "c-1",
      "m-2",
    );
    // Target gone, neighbors intact (single-row delete, not truncate).
    const ids = deps.conversationMessagesRef.current.map((m) => m.id);
    expect(ids).toEqual(["m-1", "m-3"]);
  });

  it("rolls back the removal and surfaces an error when the server DELETE fails", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    const seeded = [userMsg("m-1"), userMsg("m-2"), userMsg("m-3")];
    seedMessages(deps, seeded);
    mocks.client.deleteConversationMessage.mockRejectedValueOnce(
      new Error("boom"),
    );
    const { result } = renderHook(() => useChatSend(deps));

    let ok = true;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-2");
    });

    expect(ok).toBe(false);
    // Message restored — never a silent local-only removal on failure.
    expect(deps.conversationMessagesRef.current.map((m) => m.id)).toEqual([
      "m-1",
      "m-2",
      "m-3",
    ]);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete message"),
      "error",
      expect.any(Number),
    );
  });

  it("removes an optimistic (temp-) message locally without a server call", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    seedMessages(deps, [userMsg("temp-abc"), userMsg("m-2")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleChatDelete("temp-abc");
    });

    expect(ok).toBe(true);
    expect(mocks.client.deleteConversationMessage).not.toHaveBeenCalled();
    expect(deps.conversationMessagesRef.current.map((m) => m.id)).toEqual([
      "m-2",
    ]);
  });

  it("no-ops (returns false) when there is no active conversation", async () => {
    const deps = makeDeps({ activeConversationId: null });
    seedMessages(deps, [userMsg("m-1")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = true;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-1");
    });

    expect(ok).toBe(false);
    expect(mocks.client.deleteConversationMessage).not.toHaveBeenCalled();
  });

  it("does NOT clobber another conversation's state when the DELETE fails after a mid-delete conversation switch (#13981)", async () => {
    const deps = makeDeps({ activeConversationId: "conv-A" });
    seedMessages(deps, [userMsg("a-1"), userMsg("a-2")]);
    const convBMessages = [userMsg("b-1", "hi B"), userMsg("b-2", "reply B")];
    const del = deferred<{ ok: boolean; deletedCount: number }>();
    mocks.client.deleteConversationMessage.mockReturnValueOnce(del.promise);
    const { result } = renderHook(() => useChatSend(deps));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.handleChatDelete("a-2");
    });
    // The optimistic removal has run; the user now switches to conversation B,
    // which swaps the ref + setter to B's messages. THEN the DELETE fails.
    deps.activeConversationIdRef.current = "conv-B";
    deps.conversationMessagesRef.current = convBMessages;

    await act(async () => {
      del.reject(new Error("network"));
      await pending;
    });

    // B's displayed state is untouched — A's pre-delete snapshot never leaks in.
    expect(deps.conversationMessagesRef.current).toEqual(convBMessages);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete message"),
      "error",
      expect.any(Number),
    );
  });

  it("restores the target without clobbering a reply that streamed in during the failed DELETE (#13981)", async () => {
    const deps = makeDeps({ activeConversationId: "conv-A" });
    seedMessages(deps, [userMsg("a-user"), userMsg("a-target")]);
    const del = deferred<{ ok: boolean; deletedCount: number }>();
    mocks.client.deleteConversationMessage.mockReturnValueOnce(del.promise);
    const { result } = renderHook(() => useChatSend(deps));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.handleChatDelete("a-target");
    });
    // A reply streams into the SAME conversation while the DELETE is in flight
    // (appended to the live list). The rollback must not discard it.
    deps.conversationMessagesRef.current = [
      ...deps.conversationMessagesRef.current,
      userMsg("a-streamed", "new reply"),
    ];

    await act(async () => {
      del.reject(new Error("network"));
      await pending;
    });

    const ids = deps.conversationMessagesRef.current.map((m) => m.id);
    expect(ids).toContain("a-target"); // deleted message restored on failure
    expect(ids).toContain("a-streamed"); // the reply that streamed in is NOT lost
  });
});

describe("useChatSend reply-target attachment", () => {
  const REPLY_ID = "00000000-0000-4000-8000-00000000abcd";

  beforeEach(() => {
    vi.clearAllMocks();
    // Resolve the stream immediately so sendChatText's enqueue+drain completes.
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("ok", "ok");
        return { text: "ok", completed: true };
      },
    );
  });

  it("stamps replyToMessageId from the reply-target ref onto the send metadata and clears it", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // A reply is armed by the row affordance before the user sends.
    deps.chatReplyTargetRef.current = {
      messageId: REPLY_ID,
      senderName: "Alice",
      snippet: "the 3pm slot",
    };
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("yes please", {
        conversationId: "conv-1",
      });
    });

    // metadata is the 8th positional arg of sendConversationMessageStream.
    const metadata = mocks.client.sendConversationMessageStream.mock
      .calls[0][6] as Record<string, unknown> | undefined;
    expect(metadata?.replyToMessageId).toBe(REPLY_ID);
    // The armed reply is consumed exactly once: ref cleared + state cleared so a
    // subsequent send does not re-attach a stale reply.
    expect(deps.chatReplyTargetRef.current).toBeNull();
    expect(deps.setChatReplyTarget).toHaveBeenCalledWith(null);
  });

  it("does not attach a reply when none is armed", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const metadata = mocks.client.sendConversationMessageStream.mock
      .calls[0][6] as Record<string, unknown> | undefined;
    expect(metadata?.replyToMessageId).toBeUndefined();
    expect(deps.setChatReplyTarget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E2: auto-retry a network-failed send ONCE on reconnect (PWA dossier 2.2)
// ---------------------------------------------------------------------------

/** A transport-blip send failure (ApiError-shaped: kind:"network"). */
function networkError(): Error {
  return Object.assign(new Error("Failed to fetch"), { kind: "network" });
}

/** A timeout send failure (ApiError-shaped: kind:"timeout"). */
function timeoutError(): Error {
  return Object.assign(new Error("timed out"), { kind: "timeout" });
}

/** A non-retryable validation failure (413 payload too large). */
function validation413(): Error {
  return Object.assign(new Error("Attachment too large (max 5 MB)"), {
    status: 413,
  });
}

/** Fire the reconnect edge the auto-retry waits on, then flush its debounce. */
async function dispatchReconnectAndSettle(): Promise<void> {
  // APP_RESUME fires on every dispatch (unlike NETWORK_STATUS_CHANGE, which
  // only reacts to a true transition), so it's the deterministic wake signal.
  document.dispatchEvent(new Event(APP_RESUME_EVENT));
  // Flush the 400ms reconnect-signal debounce.
  await vi.advanceTimersByTimeAsync(500);
}

describe("isRetryableSendError classification", () => {
  it("classifies network + timeout + 502/503 as retryable", () => {
    expect(isRetryableSendError(networkError())).toBe(true);
    expect(isRetryableSendError(timeoutError())).toBe(true);
    expect(isRetryableSendError({ status: 502 })).toBe(true);
    expect(isRetryableSendError({ status: 503 })).toBe(true);
  });

  it("does NOT classify auth/rate-limit/validation/404 or aborts as retryable", () => {
    expect(isRetryableSendError({ status: 401 })).toBe(false);
    expect(isRetryableSendError({ status: 403 })).toBe(false);
    expect(isRetryableSendError({ status: 429 })).toBe(false);
    expect(isRetryableSendError({ status: 413 })).toBe(false);
    expect(isRetryableSendError({ status: 404 })).toBe(false);
    expect(isRetryableSendError(abortError())).toBe(false);
    expect(isRetryableSendError(null)).toBe(false);
    expect(isRetryableSendError(new Error("plain"))).toBe(false);
  });
});

describe("useChatSend E2 auto-retry on reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNetworkStatusForTests();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.onWsEvent.mockImplementation(() => () => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("auto-retries once when connectivity returns, reusing the same clientMessageId", async () => {
    // First attempt fails with a network blip; the reconnect signal drives a
    // single retry that succeeds. The retry MUST reuse the original
    // idempotency key so a landed-during-blip send is de-duped server-side.
    let attempt = 0;
    const seenIds: Array<string | undefined> = [];
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _ch?: string,
        _sig?: AbortSignal,
        _imgs?: unknown,
        _meta?: unknown,
        _onStatus?: unknown,
        _onTool?: unknown,
        clientMessageId?: string,
      ) => {
        attempt += 1;
        seenIds.push(clientMessageId);
        if (attempt === 1) throw networkError();
        onToken("hi there", "hi there");
        return { text: "hi there", completed: true };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      // Let the first attempt fail + arm the reconnect wait.
      await vi.advanceTimersByTimeAsync(0);
    });

    // During the wait, NO manual resend notice yet — the turn still looks like
    // it's sending.
    expect(deps.setActionNotice).not.toHaveBeenCalled();

    await act(async () => {
      await dispatchReconnectAndSettle();
      await sendPromise;
    });

    // Exactly two attempts (original + one retry), no loop.
    expect(attempt).toBe(2);
    // Same idempotency key on both attempts.
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).toBeTruthy();
    expect(seenIds[1]).toBe(seenIds[0]);
    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hi there" },
    ]);
    expect(
      new Set(deps.conversationMessagesRef.current.map(({ id }) => id)).size,
    ).toBe(2);
    // The retry succeeded — no error notice ever surfaced.
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("surfaces the manual resend affordance after the single auto-retry ALSO fails (no infinite loop)", async () => {
    // Both attempts fail with a network blip. The auto-retry fires once, and
    // when it also fails the turn flips to the manual resend path — it does NOT
    // keep retrying forever.
    let attempt = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      attempt += 1;
      throw networkError();
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await dispatchReconnectAndSettle();
      await sendPromise;
    });

    // Original + exactly one retry.
    expect(attempt).toBe(2);
    // The retry failed → manual resend notice surfaced.
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    const [msg, tone] = vi.mocked(deps.setActionNotice).mock.calls[0];
    expect(tone).toBe("error");
    expect(msg).toMatch(/resend/i);
  });

  it("does NOT auto-retry a non-retryable (validation) failure — manual affordance immediately", async () => {
    let attempt = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      attempt += 1;
      throw validation413();
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // A single attempt, no retry, and the manual notice fired right away.
    expect(attempt).toBe(1);
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    const [msg] = vi.mocked(deps.setActionNotice).mock.calls[0];
    expect(msg).toMatch(/couldn't accept that message/i);
  });

  it("does not retry once the single auto-retry has been spent even if another reconnect fires", async () => {
    // Guard against a second reconnect edge re-triggering: after the one retry
    // is consumed, a further reconnect must NOT drive a third attempt.
    let attempt = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      attempt += 1;
      throw networkError();
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await dispatchReconnectAndSettle();
      await sendPromise;
    });

    // A late, extra reconnect after the turn already settled must be inert.
    await act(async () => {
      await dispatchReconnectAndSettle();
    });

    expect(attempt).toBe(2);
  });

  it("stops waiting for reconnect (no retry) when the turn is superseded by Stop", async () => {
    // A user Stop aborts the controller the wait listens on; the auto-retry must
    // abandon quietly instead of firing into a torn-down turn.
    let attempt = 0;
    const firstAttemptStarted = deferred();
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      attempt += 1;
      firstAttemptStarted.resolve();
      throw networkError();
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      await firstAttemptStarted.promise;
      await vi.advanceTimersByTimeAsync(0);
    });

    // Stop while the retry is waiting for reconnect.
    await act(async () => {
      result.current.handleChatStop();
      await sendPromise;
    });

    // A reconnect after the stop must NOT resurrect the turn.
    await act(async () => {
      await dispatchReconnectAndSettle();
    });

    expect(attempt).toBe(1);
    // Stop is intentional — no error notice.
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });
});

describe("useChatSend manual resend still works after auto-retry exhausts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNetworkStatusForTests();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.onWsEvent.mockImplementation(() => () => {});
  });

  it("handleChatRetry re-sends after the auto-retry surfaced a failed turn", async () => {
    // After the auto-retry exhausts and the thread shows a failed assistant
    // turn, the existing manual Retry affordance must still drive a fresh send
    // (truncate + resend) — the auto-retry does not disable manual resend.
    const failedAssistantId = "asst-failed";
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.conversationMessagesRef.current = [
      { id: "user-1", role: "user", text: "hello", timestamp: Date.now() },
      {
        id: failedAssistantId,
        role: "assistant",
        text: UNDELIVERED_TURN_NOTICE,
        timestamp: Date.now(),
        failureKind: "provider_issue",
      },
    ];
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
      ) => {
        onToken("recovered", "recovered");
        return { text: "recovered", completed: true };
      },
    );
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry(failedAssistantId);
    });

    // The manual retry truncated the failed turn and re-sent the user text.
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      { inclusive: true },
    );
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const sentText =
      mocks.client.sendConversationMessageStream.mock.calls[0][1];
    expect(sentText).toBe("hello");
  });
});
