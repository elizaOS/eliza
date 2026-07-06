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
import { useChatSend } from "./useChatSend";
import { applyStreamingTextModification } from "./useStreamingText";

const apiMocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
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
 * `setConversationMessages` spy counts commits so the test can assert the
 * rAF throttle bounds them.
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
 * Integration proof for the streaming-commit THROTTLE (`useChatSend`'s rAF
 * token-coalescing seam, distinct from the reducer tested above). The reducer
 * tests prove a commit paints incrementally; this proves the production hook
 * does NOT commit once per token. `onToken` fires faster than the display can
 * paint (>60/sec on a fast model), so several tokens arriving within one frame
 * must collapse into AT MOST ONE commit, with the final text flushed once the
 * stream resolves.
 */
describe("streaming → useChatSend rAF token-coalescing throttle", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces many same-frame tokens into ≤1 commit per frame and flushes the complete text", async () => {
    // Manual rAF queue: callbacks park here and only run when we `flushFrame()`,
    // so "within one frame" is fully deterministic — no real timers.
    const rafQueue: FrameRequestCallback[] = [];
    let rafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      rafId += 1;
      return rafId;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flushFrame = () => {
      const pending = rafQueue.splice(0);
      for (const cb of pending) cb(performance.now());
    };

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

    // Cumulative snapshots arriving WITHIN one frame (no frame flushed yet).
    const snapshots = ["He", "Hell", "Hello ", "Hello the", "Hello there"];
    act(() => {
      for (const snapshot of snapshots) onToken("", snapshot);
    });

    // Throttled: many tokens, but NOT one commit each (the rAF hasn't fired).
    expect(setConversationMessages.mock.calls.length).toBeLessThan(
      snapshots.length,
    );
    const beforeFrame = setConversationMessages.mock.calls.length;

    // Flush the single scheduled frame → at most one additional commit lands.
    act(() => {
      flushFrame();
    });
    const afterFrame = setConversationMessages.mock.calls.length;
    expect(afterFrame - beforeFrame).toBeLessThanOrEqual(1);

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
});
