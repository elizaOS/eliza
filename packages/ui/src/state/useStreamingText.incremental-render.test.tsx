// @vitest-environment jsdom

/**
 * Integration proof for P10 (closing DEFERRED gap from elizaOS/eliza#8434):
 * #8773's token streaming must reach the UI as an INCREMENTAL render — the
 * visible assistant bubble text grows tick-by-tick — not merely show the final
 * reply once the stream completes.
 *
 * `useChatSend`'s streaming `onToken` callback drives the visible bubble through
 * exactly one production seam: `applyStreamingTextModification`, which patches
 * the `ConversationMessage[]` reducer that the chat surface renders. This test
 * renders a real React component backed by that same reducer state, feeds it
 * tokens across multiple commits (mirroring both delta-append and cumulative
 * snapshot `onToken` shapes), and asserts the rendered `textContent` grows
 * monotonically — proving the bubble paints partial text as tokens arrive.
 */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatToolCallEvent,
  ChatTurnStatus,
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import type { LoadConversationMessagesResult } from "./internal";
import { STREAMING_RENDER_INTERVAL_MS } from "./streaming-render-cadence";
import { useChatSend } from "./useChatSend";
import { useChatState } from "./useChatState";
import {
  applyStreamingTextModification,
  applyStreamingTextModificationsToMessages,
  type StreamingTextModification,
} from "./useStreamingText";

const apiMocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    renameConversation: vi.fn(),
    getBaseUrl: vi.fn(() => ""),
  },
}));

vi.mock("../api", () => ({
  client: apiMocks.client,
}));

vi.mock("../api/client-cloud", () => ({
  isDirectCloudSharedAgentBase: () => false,
}));

const ASSISTANT_ID = "assistant-turn-1";

function seedMessages(): ConversationMessage[] {
  return [
    { id: "user-1", role: "user", text: "say hi", timestamp: 1 },
    { id: ASSISTANT_ID, role: "assistant", text: "", timestamp: 2 },
  ];
}

/**
 * Minimal stand-in for the chat surface: holds the real `ConversationMessage[]`
 * reducer state and renders each assistant turn's visible text exactly the way
 * the bubble does (plain text node). It exposes the production setter so the
 * test can drive `applyStreamingTextModification` against live React state.
 */
function StreamingBubbleHarness({
  onReady,
}: {
  onReady: (
    setMessages: React.Dispatch<React.SetStateAction<ConversationMessage[]>>,
  ) => void;
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>(seedMessages);
  onReady(setMessages);
  return (
    <div>
      {messages.map((message) => (
        <div key={message.id} data-role={message.role} data-testid={message.id}>
          {message.text}
        </div>
      ))}
    </div>
  );
}

describe("streaming → incremental assistant-bubble render", () => {
  afterEach(cleanup);

  it("grows the visible assistant text monotonically as cumulative snapshots arrive (replace mode)", () => {
    // `onToken(token, accumulatedText)` with a string `accumulatedText` is the
    // common path: the stream sends the full text-so-far and useChatSend calls
    // applyStreamingTextModification({ mode: "replace", fullText }).
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const snapshots = ["Hel", "Hello", "Hello there", "Hello there, friend"];
    const rendered: string[] = [];

    // Before any token, the bubble is empty (typing placeholder territory).
    expect(bubble()).toBe("");

    for (const fullText of snapshots) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "replace",
          fullText,
        });
      });
      rendered.push(bubble());
    }

    // Each commit painted the new partial text...
    expect(rendered).toEqual(snapshots);
    // ...and the visible length is strictly increasing across ticks: the user
    // saw the answer build up, not appear all at once.
    for (let i = 1; i < rendered.length; i += 1) {
      expect(rendered[i].length).toBeGreaterThan(rendered[i - 1].length);
      expect(rendered[i].startsWith(rendered[i - 1])).toBe(true);
    }
    expect(bubble()).toBe("Hello there, friend");
  });

  it("grows the visible assistant text as raw delta tokens are appended (append mode)", () => {
    // The other onToken shape: no cumulative snapshot, so useChatSend merges the
    // raw delta via applyStreamingTextModification({ mode: "append", token }) —
    // the same mergeStreamingText overlap-aware accumulation used in production.
    // We assert the *property* (visible text grows tick-by-tick and ends with
    // the trailing tokens) rather than a hand-guessed concatenation, since the
    // production merge dedups suffix/prefix overlaps between deltas.
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const tokens = [
      "Two plus two",
      " is four",
      ". Anything else",
      " I can do?",
    ];
    const renders: string[] = [];

    for (const token of tokens) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "append",
          token,
        });
      });
      renders.push(bubble());
    }

    // First token paints partial text well before the stream is done.
    expect(renders[0]).toBe("Two plus two");
    // Visible text grows strictly with each delta and the prior text stays as a
    // prefix of the next — i.e. the bubble extends, it never repaints from zero.
    for (let i = 1; i < renders.length; i += 1) {
      expect(renders[i].length).toBeGreaterThan(renders[i - 1].length);
      expect(renders[i].startsWith(renders[i - 1])).toBe(true);
    }
    expect(bubble()).toBe("Two plus two is four. Anything else I can do?");
  });

  it("does not show the full reply in a single commit — intermediate paints are observed", () => {
    // Guards the regression the gap targets: if streaming were buffered, the
    // bubble would jump 0 → final in one commit and the captured intermediate
    // reads would all be empty. We capture the DOM after each tick and require
    // a genuine non-empty, non-final intermediate state to exist.
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const finalText = "Two plus two is four.";
    const snapshots = ["Two", "Two plus", "Two plus two is", finalText];
    const intermediatePaints: string[] = [];

    for (const fullText of snapshots) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "replace",
          fullText,
        });
      });
      intermediatePaints.push(bubble());
    }

    const partials = intermediatePaints.slice(0, -1);
    // At least one intermediate paint is non-empty AND shorter than the final
    // reply — i.e. the user saw the text mid-flight, not just at the end.
    expect(
      partials.some(
        (text) => text.length > 0 && text.length < finalText.length,
      ),
    ).toBe(true);
    expect(bubble()).toBe(finalText);
  });
});

describe("streaming → targeted transcript mutation", () => {
  it("updates the in-flight tail without inspecting historical message fields", () => {
    const historical = Array.from({ length: 120 }, (_, index) => {
      const message = {
        role: index % 2 === 0 ? "user" : "assistant",
        text: `history ${index}`,
        timestamp: index,
      } as ConversationMessage;
      Object.defineProperty(message, "id", {
        get() {
          throw new Error("streaming hot path inspected historical ids");
        },
      });
      return message;
    });
    const tail: ConversationMessage = {
      id: ASSISTANT_ID,
      role: "assistant",
      text: "",
      timestamp: 121,
    };
    const previous = [...historical, tail];

    const next = applyStreamingTextModificationsToMessages(previous, [
      {
        messageId: ASSISTANT_ID,
        mode: "replace",
        fullText: "Visible partial",
      },
      {
        messageId: ASSISTANT_ID,
        mode: "tool",
        event: {
          phase: "call",
          callId: "tool-1",
          toolName: "SEARCH",
        },
      },
    ]);

    expect(next).not.toBe(previous);
    for (let index = 0; index < historical.length; index += 1) {
      expect(next[index]).toBe(historical[index]);
    }
    expect(next.at(-1)).toMatchObject({
      id: ASSISTANT_ID,
      text: "Visible partial",
      toolEvents: [{ callId: "tool-1", status: "running" }],
    });
    expect(
      applyStreamingTextModificationsToMessages(next, [
        {
          messageId: ASSISTANT_ID,
          mode: "replace",
          fullText: "Visible partial",
        },
      ]),
    ).toBe(next);
  });
});

function conversationFixture(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

/**
 * Minimal `useChatSend` deps: most setters are inert spies; only the
 * conversation list + the `setConversationMessages` reducer are ref-backed
 * with real state so the streaming commits land somewhere observable. The
 * `setConversationMessages` spy counts commits so the test can assert one
 * synchronous transport burst is coalesced.
 */
function makeChatSendDeps() {
  const conversationsRef = {
    current: [conversationFixture("conv-1", "room-1")],
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: [] as ConversationMessage[],
  } as MutableRefObject<ConversationMessage[]>;

  const setConversationMessages = vi.fn((value) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  });

  const deps = {
    t: (key: string) => key,
    uiLanguage: "en",
    tab: "chat" as const,
    activeConversationId: "conv-1",
    ptySessionsRef: {
      current: [],
    } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations: vi.fn(),
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: {
      current: "conv-1",
    } as MutableRefObject<string | null>,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef: {
      current: [],
    } as MutableRefObject<ImageAttachment[]>,
    chatReplyTargetRef: { current: null },
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: {
      current: null,
    } as MutableRefObject<AbortController | null>,
    chatSendBusyRef: { current: false } as MutableRefObject<boolean>,
    chatSendNonceRef: { current: 0 } as MutableRefObject<number>,
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
  return { deps, setConversationMessages, conversationMessagesRef };
}

function useProductionChatSendHarness(
  onStreamingBatch?: (batch: readonly StreamingTextModification[]) => void,
) {
  const chat = useChatState();
  const statusesRef = useRef<ChatTurnStatus[]>([]);
  const ptySessionsRef = useRef<CodingAgentSession[]>([]);
  const observedBatchesRef = useRef<
    ReadonlyArray<readonly StreamingTextModification[]>
  >([]);
  const applyStreamingMessageModifications = useCallback(
    (batch: readonly StreamingTextModification[]) => {
      observedBatchesRef.current = [...observedBatchesRef.current, batch];
      onStreamingBatch?.(batch);
      chat.applyStreamingMessageModifications(batch);
    },
    [chat.applyStreamingMessageModifications, onStreamingBatch],
  );
  const send = useChatSend({
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: chat.state.activeConversationId,
    ptySessionsRef,
    setChatInput: chat.setChatInput,
    setChatSending: chat.setChatSending,
    setChatFirstTokenReceived: chat.setChatFirstTokenReceived,
    setServerTurnStatus: (status) => {
      if (status) statusesRef.current = [...statusesRef.current, status];
    },
    setChatLastUsage: chat.setChatLastUsage,
    setChatPendingImages: chat.setChatPendingImages,
    setConversations: chat.setConversations,
    setActiveConversationId: chat.setActiveConversationId,
    setCompanionMessageCutoffTs: chat.setCompanionMessageCutoffTs,
    setConversationMessages: chat.setConversationMessages,
    applyStreamingMessageModifications,
    setUnreadConversations: () => {},
    setChatReplyTarget: chat.setChatReplyTarget,
    setActionNotice: () => {},
    activeConversationIdRef: chat.activeConversationIdRef,
    chatInputRef: chat.chatInputRef,
    chatPendingImagesRef: chat.chatPendingImagesRef,
    chatReplyTargetRef: chat.chatReplyTargetRef,
    conversationsRef: chat.conversationsRef,
    conversationMessagesRef: chat.conversationMessagesRef,
    chatAbortRef: chat.chatAbortRef,
    chatSendBusyRef: chat.chatSendBusyRef,
    chatSendNonceRef: chat.chatSendNonceRef,
    loadConversations: async () => chat.conversationsRef.current,
    loadConversationMessages: async () => ({ ok: true }),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: async () => true,
  });
  return { chat, send, observedBatchesRef, statusesRef };
}

type CapturedStream = {
  conversationId: string;
  onToken: (token: string, accumulatedText?: string) => void;
  onStatus?: (status: ChatTurnStatus) => void;
  onToolEvent?: (event: ChatToolCallEvent) => void;
  resolve: (value: { text: string; completed: boolean }) => void;
  reject: (error: unknown) => void;
};

function installPendingStreams(): CapturedStream[] {
  const streams: CapturedStream[] = [];
  apiMocks.client.sendConversationMessageStream.mockImplementation(
    (
      conversationId: string,
      _text: string,
      onToken: CapturedStream["onToken"],
      _channelType: string,
      signal: AbortSignal,
      _images: unknown,
      _metadata: unknown,
      onStatus?: CapturedStream["onStatus"],
      onToolEvent?: CapturedStream["onToolEvent"],
    ) =>
      new Promise((resolve, reject) => {
        const stream: CapturedStream = {
          conversationId,
          onToken,
          onStatus,
          onToolEvent,
          resolve,
          reject,
        };
        streams.push(stream);
        signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );
  return streams;
}

async function seedProductionChat(
  result: {
    current: ReturnType<typeof useProductionChatSendHarness>;
  },
  conversationId = "conv-1",
): Promise<void> {
  await act(async () => {
    result.current.chat.setConversations([
      conversationFixture(conversationId, `room-${conversationId}`),
    ]);
    result.current.chat.setActiveConversationId(conversationId);
    result.current.chat.setConversationMessages([
      {
        id: `${conversationId}-history`,
        role: "assistant",
        text: "Existing history",
        timestamp: 1,
      },
    ]);
    await Promise.resolve();
  });
}

/**
 * Integration proof for the streaming-paint coalescer in `useChatSend`,
 * distinct from the reducer tested above. The reducer tests prove a commit
 * paints incrementally; these prove synchronous transport bursts collapse,
 * separate fast events stay bounded, and terminal text flushes without loss.
 */
describe("streaming → useChatSend paint coalescing", () => {
  let nextFrameId = 1;
  let frameCallbacks = new Map<number, FrameRequestCallback>();
  let cancelledFrameCallbacks = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    nextFrameId = 1;
    frameCallbacks = new Map();
    cancelledFrameCallbacks = new Map();
    apiMocks.client.abortConversationTurn.mockResolvedValue({ aborted: true });
    apiMocks.client.renameConversation.mockResolvedValue(undefined);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        frameCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        const callback = frameCallbacks.get(id);
        if (callback) cancelledFrameCallbacks.set(id, callback);
        frameCallbacks.delete(id);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function paintNextFrame(): Promise<void> {
    const entry = frameCallbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("Expected a scheduled streaming frame");
    const [id, callback] = entry;
    frameCallbacks.delete(id);
    await act(async () => {
      callback(performance.now());
      await Promise.resolve();
    });
  }

  async function runCancelledFrame(): Promise<void> {
    const entry = cancelledFrameCallbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("Expected a cancelled streaming frame");
    const [id, callback] = entry;
    cancelledFrameCallbacks.delete(id);
    await act(async () => {
      callback(performance.now());
      await Promise.resolve();
    });
  }

  it("coalesces one synchronous token burst into one commit and flushes terminal text", async () => {
    // Capture the streaming `onToken` (3rd arg) and resolve the stream when we
    // decide the turn is done, so we control exactly when flushStreamingText runs.
    let onToken!: (token: string, accumulatedText?: string) => void;
    let resolveStream!: (data: { text: string; completed: boolean }) => void;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (t: string, acc?: string) => void,
      ) => {
        onToken = token;
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );

    const { deps, setConversationMessages, conversationMessagesRef } =
      makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      // Let the send reach the stream call so `onToken` is captured.
      await Promise.resolve();
    });

    // The optimistic user + empty-assistant bubbles seed the reducer; reset the
    // commit counter so we measure ONLY the streaming-token commits.
    setConversationMessages.mockClear();

    // Cumulative snapshots decoded from one synchronous transport burst.
    const snapshots = ["He", "Hell", "Hello ", "Hello the", "Hello there"];
    await act(async () => {
      for (const snapshot of snapshots) onToken("", snapshot);
      await Promise.resolve();
    });

    expect(setConversationMessages).not.toHaveBeenCalled();
    await paintNextFrame();
    expect(setConversationMessages).toHaveBeenCalledTimes(1);

    // The streamed text painted so far is the latest parked snapshot.
    const assistantText = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant")
        ?.text ?? "";
    expect(assistantText()).toBe("Hello there");

    // Stream resolves → flushStreamingText commits the final text, no loss.
    await act(async () => {
      resolveStream({ text: "Hello there, friend", completed: true });
      await sendPromise;
    });
    expect(assistantText()).toBe("Hello there, friend");
  });

  it("bounds paints across separate fast token events and flushes terminal text immediately", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance"],
    });
    let onToken!: (token: string, accumulatedText?: string) => void;
    let resolveStream!: (data: { text: string; completed: boolean }) => void;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (t: string, acc?: string) => void,
      ) => {
        onToken = token;
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );

    const { deps, setConversationMessages, conversationMessagesRef } =
      makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    setConversationMessages.mockClear();

    const assistantText = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant")
        ?.text ?? "";

    await act(async () => {
      onToken("", "A");
      await Promise.resolve();
    });
    expect(setConversationMessages).not.toHaveBeenCalled();
    await paintNextFrame();
    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    expect(assistantText()).toBe("A");

    const fastSnapshots = ["AB", "ABC", "ABCD", "ABCDE", "ABCDEF", "ABCDEFG"];
    for (const snapshot of fastSnapshots) {
      await act(async () => {
        onToken("", snapshot);
        await Promise.resolve();
      });
    }

    // Separate transport events inside the cadence window share one cumulative
    // snapshot and do not schedule one render frame per token.
    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    expect(frameCallbacks.size).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAMING_RENDER_INTERVAL_MS - 1);
    });
    expect(frameCallbacks.size).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await paintNextFrame();
    expect(setConversationMessages).toHaveBeenCalledTimes(2);
    expect(assistantText()).toBe("ABCDEFG");

    const commitsBeforeTerminal = setConversationMessages.mock.calls.length;
    await act(async () => {
      onToken("", "ABCDEFGH");
      resolveStream({ text: "ABCDEFGHI", completed: true });
      await sendPromise;
    });
    expect(assistantText()).toBe("ABCDEFGHI");
    expect(setConversationMessages.mock.calls.length).toBeGreaterThan(
      commitsBeforeTerminal,
    );

    const commitsAfterTerminal = setConversationMessages.mock.calls.length;
    expect(frameCallbacks.size).toBe(0);
    expect(setConversationMessages).toHaveBeenCalledTimes(commitsAfterTerminal);
  });

  it("uses the production ref-backed batch for text and multiple terminal tool lifecycles", async () => {
    const streams = installPendingStreams();
    const observed: StreamingTextModification[][] = [];
    const { result } = renderHook(() =>
      useProductionChatSendHarness((batch) => observed.push([...batch])),
    );
    await seedProductionChat(result);

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.send.sendChatText("search", {
        conversationId: "conv-1",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(1));
    });

    await act(async () => {
      streams[0].onToken("", "Searching");
      streams[0].onStatus?.({ kind: "running_tool", toolName: "search" });
      streams[0].onToolEvent?.({
        phase: "call",
        callId: "call-1",
        toolName: "search",
        args: { query: "one" },
      });
      streams[0].onToolEvent?.({
        phase: "result",
        callId: "call-1",
        toolName: "search",
        result: { hits: 1 },
      });
      streams[0].onToolEvent?.({
        phase: "call",
        callId: "call-2",
        toolName: "fetch",
        args: { url: "https://example.test" },
      });
      streams[0].onToolEvent?.({
        phase: "error",
        callId: "call-2",
        toolName: "fetch",
        error: "denied",
      });
      streams[0].resolve({ text: "Searching complete", completed: true });
      await sendPromise;
    });

    expect(observed).toHaveLength(2);
    expect(observed[0].map((modification) => modification.mode)).toEqual([
      "replace",
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
    expect(observed[1].map((modification) => modification.mode)).toEqual([
      "complete",
    ]);
    const assistant =
      result.current.chat.conversationMessagesRef.current.at(-1);
    expect(assistant?.text).toBe("Searching complete");
    expect(assistant?.toolEvents).toEqual([
      expect.objectContaining({
        callId: "call-1",
        status: "completed",
        args: { query: "one" },
        result: { hits: 1 },
      }),
      expect.objectContaining({
        callId: "call-2",
        status: "failed",
        args: { url: "https://example.test" },
        error: "denied",
      }),
    ]);
    expect(result.current.observedBatchesRef.current).toHaveLength(2);
    expect(frameCallbacks.size).toBe(0);
  });

  it("keeps a cancelled frame from an aborted turn out of the next turn", async () => {
    const streams = installPendingStreams();
    const { result } = renderHook(() => useProductionChatSendHarness());
    await seedProductionChat(result);

    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = result.current.send.sendChatText("first", {
        conversationId: "conv-1",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(1));
    });
    act(() => streams[0].onToken("", "first partial"));
    expect(frameCallbacks.size).toBe(1);

    await act(async () => {
      result.current.send.handleChatStop();
      await firstSend;
    });
    expect(cancelledFrameCallbacks.size).toBe(1);

    let secondSend!: Promise<void>;
    await act(async () => {
      secondSend = result.current.send.sendChatText("second", {
        conversationId: "conv-1",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(2));
    });
    act(() => streams[1].onToken("", "second partial"));

    await runCancelledFrame();
    const assistantsBeforeCurrentFrame =
      result.current.chat.conversationMessagesRef.current.filter(
        (message) => message.role === "assistant",
      );
    expect(assistantsBeforeCurrentFrame.at(-1)?.text).toBe("");

    await paintNextFrame();
    expect(
      result.current.chat.conversationMessagesRef.current
        .filter((message) => message.role === "assistant")
        .at(-1)?.text,
    ).toBe("second partial");

    await act(async () => {
      streams[1].resolve({ text: "second complete", completed: true });
      await secondSend;
    });
    expect(
      result.current.chat.conversationMessagesRef.current.some(
        (message) => message.text === "first partial",
      ),
    ).toBe(true);
    expect(
      result.current.chat.conversationMessagesRef.current.at(-1)?.text,
    ).toBe("second complete");
  });

  it("generation-guards a stale microtask fallback across abort and the next turn", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const microtasks: Array<() => void> = [];
    vi.stubGlobal("queueMicrotask", (callback: () => void) => {
      microtasks.push(callback);
    });
    const streams = installPendingStreams();
    const { result } = renderHook(() => useProductionChatSendHarness());
    await seedProductionChat(result);

    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = result.current.send.sendChatText("first", {
        conversationId: "conv-1",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(1));
    });
    const microtasksBeforeFirstToken = microtasks.length;
    act(() => streams[0].onToken("", "first partial"));
    expect(microtasks).toHaveLength(microtasksBeforeFirstToken + 1);
    const staleStreamingMicrotask = microtasks.at(-1);

    await act(async () => {
      result.current.send.handleChatStop();
      await firstSend;
    });

    let secondSend!: Promise<void>;
    await act(async () => {
      secondSend = result.current.send.sendChatText("second", {
        conversationId: "conv-1",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(2));
    });
    const microtasksBeforeSecondToken = microtasks.length;
    act(() => streams[1].onToken("", "second partial"));
    expect(microtasks).toHaveLength(microtasksBeforeSecondToken + 1);
    const currentStreamingMicrotask = microtasks.at(-1);

    act(() => staleStreamingMicrotask?.());
    expect(
      result.current.chat.conversationMessagesRef.current.at(-1)?.text,
    ).toBe("");
    act(() => currentStreamingMicrotask?.());
    expect(
      result.current.chat.conversationMessagesRef.current.at(-1)?.text,
    ).toBe("second partial");

    await act(async () => {
      streams[1].resolve({ text: "second complete", completed: true });
      await secondSend;
    });
  });

  it("drops an inactive conversation frame and resumes cleanly after returning", async () => {
    const streams = installPendingStreams();
    const { result } = renderHook(() => useProductionChatSendHarness());
    await seedProductionChat(result, "conv-A");

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.send.sendChatText("A turn", {
        conversationId: "conv-A",
      });
      await vi.waitFor(() => expect(streams).toHaveLength(1));
    });
    const conversationAMessages = [
      ...result.current.chat.conversationMessagesRef.current,
    ];
    act(() => streams[0].onToken("", "must not cross conversations"));

    act(() => {
      result.current.chat.setActiveConversationId("conv-B");
      result.current.chat.setConversationMessages([
        {
          id: "b-message",
          role: "assistant",
          text: "Conversation B",
          timestamp: 20,
        },
      ]);
    });
    await paintNextFrame();
    expect(result.current.chat.conversationMessagesRef.current).toEqual([
      expect.objectContaining({ id: "b-message", text: "Conversation B" }),
    ]);

    act(() => {
      result.current.chat.setActiveConversationId("conv-A");
      result.current.chat.setConversationMessages(conversationAMessages);
    });
    expect(
      result.current.chat.conversationMessagesRef.current.some(
        (message) => message.text === "must not cross conversations",
      ),
    ).toBe(false);

    act(() => streams[0].onToken("", "A resumed"));
    await paintNextFrame();
    expect(
      result.current.chat.conversationMessagesRef.current.at(-1)?.text,
    ).toBe("A resumed");

    await act(async () => {
      streams[0].resolve({ text: "A complete", completed: true });
      await sendPromise;
    });
  });
});
