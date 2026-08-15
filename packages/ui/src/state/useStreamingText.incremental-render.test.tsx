/** Verifies streaming → incremental assistant-bubble render through the package's configured test harness. */
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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import type { LoadConversationMessagesResult } from "./internal";
import { STREAMING_RENDER_INTERVAL_MS } from "./streaming-render-cadence";
import { useChatSend } from "./useChatSend";
import { applyStreamingTextModification } from "./useStreamingText";

const apiMocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    stopConversationMessagePresentation: vi.fn(async () => ({
      ok: true,
      state: "stopped",
      interrupted: true,
    })),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    renameConversation: vi.fn(async () => undefined),
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

/**
 * Integration proof for the streaming-paint coalescer in `useChatSend`,
 * distinct from the reducer tested above. The reducer tests prove a commit
 * paints incrementally; these prove synchronous transport bursts collapse,
 * separate fast events stay bounded, and terminal text flushes without loss.
 */
describe("streaming → useChatSend paint coalescing", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

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
    vi.useFakeTimers();
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
    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    expect(assistantText()).toBe("A");

    const fastSnapshots = ["AB", "ABC", "ABCD", "ABCDE", "ABCDEF", "ABCDEFG"];
    for (const snapshot of fastSnapshots) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
        onToken("", snapshot);
        await Promise.resolve();
      });
    }

    // Six transport events arrived in 60 ms, inside one paint interval. Their
    // cumulative text is parked without six expensive overlay commits.
    expect(setConversationMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAMING_RENDER_INTERVAL_MS);
    });
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
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(setConversationMessages).toHaveBeenCalledTimes(commitsAfterTerminal);
    vi.useRealTimers();
  });

  it("paces one large atomic provider snapshot through terminal completion", async () => {
    vi.useFakeTimers();
    const finalText =
      "The declaration arrives as one provider snapshot, but the interface " +
      "must still reveal it as readable progressive text. ".repeat(8);
    let onToken!: (token: string, accumulatedText?: string) => void;
    let resolveStream!: (data: {
      text: string;
      completed: boolean;
      messageId: string;
      userMessageId: string;
    }) => void;
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

    const { deps, conversationMessagesRef, setConversationMessages } =
      makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("give me the long answer", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      onToken("", finalText);
      await Promise.resolve();
    });

    const assistant = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant");
    const firstPaint = assistant()?.text ?? "";
    expect(firstPaint.length).toBeGreaterThan(0);
    expect(firstPaint.length).toBeLessThan(finalText.length);
    expect(finalText.startsWith(firstPaint)).toBe(true);

    // The network may settle before the presentation queue drains. Terminal
    // reconciliation keeps the same prefix instead of dumping the hidden tail.
    await act(async () => {
      resolveStream({
        text: finalText,
        completed: true,
        messageId: "persisted-assistant-1",
        userMessageId: "persisted-user-1",
      });
      await sendPromise;
    });
    expect(assistant()?.text).toBe(firstPaint);
    expect(assistant()?.id).toBe("persisted-assistant-1");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const commitsBeforeRevealTick = setConversationMessages.mock.calls.length;

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(setConversationMessages.mock.calls.length).toBeGreaterThan(
      commitsBeforeRevealTick,
    );
    const secondPaint = assistant()?.text ?? "";
    expect(secondPaint.length).toBeGreaterThan(firstPaint.length);
    expect(finalText.startsWith(secondPaint)).toBe(true);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(assistant()?.text).toBe(finalText);
    expect(assistant()?.interrupted).not.toBe(true);
  });

  it("paces a large terminal-only answer when the provider emitted no token callback", async () => {
    vi.useFakeTimers();
    const finalText = "Terminal-only answer with exact text. ".repeat(20);
    let resolveStream!: (data: { text: string; completed: boolean }) => void;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
    );

    const { deps, conversationMessagesRef } = makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("terminal only", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      resolveStream({ text: finalText, completed: true });
      await sendPromise;
    });

    const assistantText = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant")
        ?.text ?? "";
    expect(assistantText().length).toBeGreaterThan(0);
    expect(assistantText().length).toBeLessThan(finalText.length);
    expect(finalText.startsWith(assistantText())).toBe(true);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(assistantText()).toBe(finalText);
  });

  it("reapplies the paced prefix after an authoritative history reload", async () => {
    vi.useFakeTimers();
    const finalText = "Action-backed history must not bypass pacing. ".repeat(
      20,
    );
    apiMocks.client.sendConversationMessageStream.mockResolvedValue({
      text: finalText,
      completed: true,
      historyRefreshRequired: true,
      messageId: "persisted-action-assistant",
      userMessageId: "persisted-action-user",
    });

    const { deps, conversationMessagesRef, setConversationMessages } =
      makeChatSendDeps();
    deps.loadConversationMessages.mockImplementation(async () => {
      setConversationMessages([
        {
          id: "persisted-action-user",
          role: "user",
          text: "run the action",
          timestamp: 1,
        },
        {
          id: "persisted-action-assistant",
          role: "assistant",
          text: finalText,
          timestamp: 2,
        },
      ]);
      return { ok: true };
    });

    const { result } = renderHook(() => useChatSend(deps));
    await act(async () => {
      await result.current.sendChatText("run the action", {
        conversationId: "conv-1",
      });
    });

    const assistantText = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant")
        ?.text ?? "";
    expect(deps.loadConversationMessages).toHaveBeenCalled();
    expect(assistantText().length).toBeGreaterThan(0);
    expect(assistantText().length).toBeLessThan(finalText.length);
    expect(finalText.startsWith(assistantText())).toBe(true);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(assistantText()).toBe(finalText);
  });

  it("Stop freezes the painted prefix and rejects parked, timed, and late old-turn text", async () => {
    vi.useFakeTimers();
    apiMocks.client.abortConversationTurn.mockResolvedValue(undefined);
    const fullText = "Hidden suffixes must never appear after Stop. ".repeat(
      20,
    );
    let onToken!: (token: string, accumulatedText?: string) => void;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (t: string, acc?: string) => void,
        _channel: unknown,
        signal: AbortSignal,
      ) => {
        onToken = token;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );

    const { deps, conversationMessagesRef } = makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("start long answer", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      onToken("", fullText);
      await Promise.resolve();
    });
    const assistant = () =>
      conversationMessagesRef.current.find((m) => m.role === "assistant");
    const visibleAtStop = assistant()?.text ?? "";
    expect(visibleAtStop.length).toBeGreaterThan(0);
    expect(visibleAtStop.length).toBeLessThan(fullText.length);

    await act(async () => {
      result.current.interruptActiveChatPipeline();
      await sendPromise;
    });
    expect(assistant()?.text).toBe(visibleAtStop);
    expect(assistant()?.interrupted).toBe(true);

    await act(async () => {
      onToken("", `${fullText} LATE OLD TURN`);
      await vi.runAllTimersAsync();
    });
    expect(assistant()?.text).toBe(visibleAtStop);
    expect(assistant()?.text).not.toContain("LATE OLD TURN");
  });

  it("a replacement user turn freezes a terminal answer that is still visually draining", async () => {
    vi.useFakeTimers();
    const firstFinal = "The old answer still has an unseen suffix. ".repeat(20);
    let firstOnToken!: (token: string, accumulatedText?: string) => void;
    const durableAssistantId = "00000000-0000-4000-8000-0000000000a1";
    const durableUserId = "00000000-0000-4000-8000-0000000000b1";
    let resolveFirst!: (data: {
      text: string;
      completed: boolean;
      messageId: string;
      userMessageId: string;
    }) => void;
    let callCount = 0;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (t: string, acc?: string) => void,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          firstOnToken = token;
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ text: "New answer.", completed: true });
      },
    );

    const { deps, conversationMessagesRef } = makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    let firstSend: Promise<void> | undefined;
    await act(async () => {
      firstSend = result.current.sendChatText("first question", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      firstOnToken("", firstFinal);
      await Promise.resolve();
      resolveFirst({
        text: firstFinal,
        completed: true,
        messageId: durableAssistantId,
        userMessageId: durableUserId,
      });
      await firstSend;
    });

    const assistants = () =>
      conversationMessagesRef.current.filter((m) => m.role === "assistant");
    const frozenPrefix = assistants()[0]?.text ?? "";
    expect(frozenPrefix.length).toBeGreaterThan(0);
    expect(frozenPrefix.length).toBeLessThan(firstFinal.length);

    await act(async () => {
      await result.current.sendChatText("replacement question", {
        conversationId: "conv-1",
      });
    });
    expect(assistants()[0]?.text).toBe(frozenPrefix);
    expect(assistants()[0]?.interrupted).toBe(true);
    expect(assistants().at(-1)?.text).toBe("New answer.");
    expect(
      apiMocks.client.stopConversationMessagePresentation,
    ).toHaveBeenCalledWith(
      "conv-1",
      durableAssistantId,
      frozenPrefix,
      firstFinal,
    );
    expect(
      apiMocks.client.stopConversationMessagePresentation.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      apiMocks.client.sendConversationMessageStream.mock.invocationCallOrder[1],
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(assistants()[0]?.text).toBe(frozenPrefix);
    expect(firstFinal.startsWith(assistants()[0]?.text ?? "")).toBe(true);
  });

  it("retries a transient stopped-prefix save before dispatching the replacement", async () => {
    vi.useFakeTimers();
    const firstFinal =
      "The saved prefix must win over this hidden tail. ".repeat(20);
    const durableAssistantId = "00000000-0000-4000-8000-0000000000a2";
    const durableUserId = "00000000-0000-4000-8000-0000000000b2";
    let firstToken!: (token: string, accumulatedText?: string) => void;
    let callCount = 0;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (value: string, accumulated?: string) => void,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          firstToken = token;
          return Promise.resolve({
            text: firstFinal,
            completed: true,
            messageId: durableAssistantId,
            userMessageId: durableUserId,
          });
        }
        return Promise.resolve({ text: "Replacement safe.", completed: true });
      },
    );
    apiMocks.client.stopConversationMessagePresentation
      .mockRejectedValueOnce(new Error("temporary disconnect"))
      .mockResolvedValueOnce({
        ok: true,
        state: "stopped",
        interrupted: true,
      });

    const { deps } = makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    await act(async () => {
      const first = result.current.sendChatText("first", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      firstToken("", firstFinal);
      await first;
    });

    await act(async () => {
      await result.current.sendChatText("replacement", {
        conversationId: "conv-1",
      });
    });

    expect(
      apiMocks.client.stopConversationMessagePresentation,
    ).toHaveBeenCalledTimes(2);
    expect(apiMocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(
      2,
    );
    expect(
      apiMocks.client.stopConversationMessagePresentation.mock
        .invocationCallOrder[1],
    ).toBeLessThan(
      apiMocks.client.sendConversationMessageStream.mock.invocationCallOrder[1],
    );
  });

  it("fails closed instead of sending a replacement past an unsaved stopped prefix", async () => {
    vi.useFakeTimers();
    const firstFinal = "This hidden suffix must never outrun history. ".repeat(
      20,
    );
    let firstToken!: (token: string, accumulatedText?: string) => void;
    apiMocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        token: (value: string, accumulated?: string) => void,
      ) => {
        firstToken = token;
        return Promise.resolve({
          text: firstFinal,
          completed: true,
          messageId: "00000000-0000-4000-8000-0000000000a3",
          userMessageId: "00000000-0000-4000-8000-0000000000b3",
        });
      },
    );
    apiMocks.client.stopConversationMessagePresentation.mockRejectedValue(
      new Error("history unavailable"),
    );

    const { deps } = makeChatSendDeps();
    const { result } = renderHook(() => useChatSend(deps));
    await act(async () => {
      const first = result.current.sendChatText("first", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
      firstToken("", firstFinal);
      await first;
    });

    await act(async () => {
      await result.current.sendChatText("replacement", {
        conversationId: "conv-1",
      });
    });

    expect(
      apiMocks.client.stopConversationMessagePresentation,
    ).toHaveBeenCalledTimes(2);
    expect(apiMocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("next message was held"),
      "error",
      10_000,
    );
  });
});
