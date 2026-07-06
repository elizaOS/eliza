// @vitest-environment jsdom

// Component-level coverage for the chat STOP affordance — the in-composer
// "stop generation" control wired to useChatSend.handleChatStop.
//
// WHY THIS LIVES HERE (and not as a /chat ui-smoke Playwright spec): the web
// /chat surface is the ContinuousChatOverlay, which has NO stop control — its
// only trailing action is send/mic, and `handleChatStop`/`onStop` is never
// wired into it (ContinuousChatOverlay.tsx). The full ChatComposer that DOES
// carry the stop button (chat-composer.tsx, shouldShowStopButton) is consumed
// by ChatView, which is no longer mounted on any web route (AppWorkspaceChrome
// stopped falling back to an in-view ChatView; /chat is overlay-only). So the
// stop button + its server-abort wiring is unreachable from a browser route and
// cannot be driven by a deterministic ui-smoke spec — see chat-stop-cancel
// notes. This test exercises the real seam directly: the real ChatComposer
// renders the stop control while a turn is in flight, and clicking it runs the
// real useChatSend.handleChatStop, which (a) aborts the in-flight stream so the
// assistant bubble stops growing and (b) POSTs the backend turn abort.

import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../../../api";
import type { LoadConversationMessagesResult } from "../../../state/internal";
import { type UseChatSendDeps, useChatSend } from "../../../state/useChatSend";
import { ChatComposer, type ChatComposerVoiceState } from "./chat-composer";

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
  },
}));

vi.mock("../../../api", () => ({ client: mocks.client }));

const idleVoice: ChatComposerVoiceState = {
  assistantTtsQuality: "standard",
  captureMode: "idle",
  interimTranscript: "",
  isListening: false,
  isSpeaking: false,
  startListening: () => {},
  stopListening: () => {},
  supported: true,
};

const translate = (key: string): string => {
  const map: Record<string, string> = {
    "common.send": "Send",
    "common.message": "Message",
    "chat.stopGeneration": "Stop generation",
  };
  return map[key] ?? key;
};

function StopComposerHarness({
  chatSending,
  onStop,
}: {
  chatSending: boolean;
  onStop: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <ChatComposer
      variant="default"
      layout="inline"
      textareaRef={ref}
      chatInput=""
      chatPendingImagesCount={0}
      isComposerLocked={false}
      isAgentStarting={false}
      chatSending={chatSending}
      voice={idleVoice}
      agentVoiceEnabled={false}
      showAgentVoiceToggle={false}
      t={translate}
      onAttachImage={() => {}}
      onChatInputChange={() => {}}
      onSend={() => {}}
      onStop={onStop}
      onStopSpeaking={() => {}}
      onToggleAgentVoice={() => {}}
    />
  );
}

describe("ChatComposer stop affordance", () => {
  it("renders the stop control only while a turn is in flight and no draft is pending", () => {
    const onStop = vi.fn();
    const { rerender, queryByTitle, getByTitle } = render(
      <StopComposerHarness chatSending={false} onStop={onStop} />,
    );
    // Idle: no stop control is present (the trailing action is the mic).
    expect(queryByTitle("Stop generation")).toBeNull();

    rerender(<StopComposerHarness chatSending onStop={onStop} />);
    const action = getByTitle("Stop generation");
    expect(action.getAttribute("data-testid")).toBe("chat-composer-action");

    fireEvent.click(action);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

// ── Real abort wiring (useChatSend.handleChatStop) ───────────────────────────

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}

function makeDeps(
  conversations: Conversation[],
  activeConversationId: string,
): {
  deps: UseChatSendDeps;
  conversationMessagesRef: { current: ConversationMessage[] };
} {
  const conversationsRef = { current: conversations };
  const conversationMessagesRef: { current: ConversationMessage[] } = {
    current: [],
  };
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  };
  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId,
    ptySessionsRef: { current: [] as CodingAgentSession[] },
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations: (value) => {
      conversationsRef.current =
        typeof value === "function" ? value(conversationsRef.current) : value;
    },
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: { current: activeConversationId },
    chatInputRef: { current: "" },
    chatPendingImagesRef: { current: [] as ImageAttachment[] },
    chatReplyTargetRef: { current: null },
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: { current: null },
    chatSendBusyRef: { current: false },
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
  return { deps, conversationMessagesRef };
}

describe("useChatSend.handleChatStop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.abortConversationTurn.mockResolvedValue({
      aborted: true,
      roomId: "room-1",
      reason: "ui-chat-stop",
    });
  });

  it("keeps the interrupted partial (marked interrupted) and POSTs the backend turn abort", async () => {
    const started = deferred();
    let emitToken: ((token: string) => void) | null = null;
    let lastStreamed = "";
    // Mirror the REAL stream client (client-base.ts): a user Stop aborts the
    // signal, and the client CANCELS the reader and RESOLVES with whatever
    // streamed so far as an interrupted turn (`completed: false`) — it does NOT
    // reject with an AbortError. That resolve is exactly what drives
    // useChatSend's interrupt-marking + reattachInterruptedPartial; a mock that
    // rejected instead would exercise the wrong (drop-empty-placeholder) path
    // and could never assert the interrupted bubble is KEPT.
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
        _channelType: string,
        signal?: AbortSignal,
      ) => {
        emitToken = (token: string) => {
          lastStreamed = token;
          onToken(token, token);
        };
        started.resolve();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve({
                text: lastStreamed,
                agentName: "Eliza",
                completed: false,
              }),
            { once: true },
          );
        });
      },
    );

    const { deps, conversationMessagesRef } = makeDeps(
      [conversation("conv-1", "room-1")],
      "conv-1",
    );
    // Simulate the post-turn history reload: the server did NOT persist the
    // reply that was cut off mid-stream, so the reload full-replaces the thread
    // with just the user turn. This is precisely the case reattachInterruptedPartial
    // exists to heal — without it the partial the user watched stream in would
    // silently vanish. Assigned BEFORE renderHook so useChatSend's callbacks
    // close over this override.
    deps.loadConversationMessages = vi.fn(
      async (): Promise<LoadConversationMessagesResult> => {
        conversationMessagesRef.current =
          conversationMessagesRef.current.filter((m) => m.role === "user");
        return { ok: true };
      },
    );
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    // The stream emits one token; useChatSend coalesces token->state into one
    // rAF-batched commit (~30fps), so advance a frame to let the parked text
    // flush, then assert the assistant bubble grew to that text.
    act(() => {
      emitToken?.("partial reply so far");
    });
    await act(
      async () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    const assistantBefore = conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    );
    expect(assistantBefore?.text).toBe("partial reply so far");

    // Stop: abort fires, the stream resolves as interrupted, the partial is
    // marked + reattached after the reload that dropped it.
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
    // STOP-keeps-the-partial (reattachInterruptedPartial): after the stop, the
    // partial assistant bubble the user watched stream in MUST still exist,
    // carry the interrupted marker, and hold exactly the partial text — even
    // though the post-turn reload full-replaced the thread without it. No
    // `?? fallback`: a deleted bubble (the pre-fix regression) fails here.
    const assistantAfter = conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    );
    expect(assistantAfter).toBeDefined();
    expect(assistantAfter?.interrupted).toBe(true);
    expect(assistantAfter?.text).toBe("partial reply so far");
    // And it is the ONLY assistant turn — reattach never duplicates the bubble.
    expect(
      conversationMessagesRef.current.filter((m) => m.role === "assistant")
        .length,
    ).toBe(1);
  });
});
