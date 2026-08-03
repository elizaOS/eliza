/**
 * Browser fixture for the chat frame and layout-stability gate. It drives the
 * production chat state, send coalescer, shell-controller projection, and
 * ChatOverlay while replacing only the remote SSE transport with a deterministic
 * callback source. This keeps frame metrics reproducible without bypassing the
 * state path whose streaming performance the gate protects.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  type ChatTurnStatus,
  client,
  type CodingAgentSession,
  type ConversationMessage,
} from "../../../api";
import { MockAppProvider } from "../../../storybook/mock-providers";
import {
  ChatComposerCtx,
  type ChatComposerValue,
} from "../../../state/ChatComposerContext.hooks";
import { ChatTurnStatusCtx } from "../../../state/ChatTurnStatusContext.hooks";
import { ConversationMessagesCtx } from "../../../state/ConversationMessagesContext.hooks";
import { useChatSend } from "../../../state/useChatSend";
import { useChatState } from "../../../state/useChatState";
import { ChatOverlay } from "../ChatOverlay";
import { useShellController } from "../useShellController";

const CONVERSATION_ID = "perf-thread";
const ROOM_ID = "perf-room";
const TURNS = 40;
const TAIL_WIDGET_PREFIX =
  "Here is my answer so far, streaming in token by token. " +
  "[CHOICE:disambiguate id=perf-choice]\nyes=Yes, proceed\nno=No, cancel\n[/CHOICE]\n";
const STREAMED_BODY =
  "It is routed through the single runner, pattern-matched on structural fields. ".repeat(
    20,
  );

function longThread(): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (let index = 0; index < TURNS; index += 1) {
    messages.push({
      id: `u${index}`,
      role: "user",
      text: `turn ${index}: ${"how does the scheduler route this task? ".repeat(2)}`,
      timestamp: index * 2 + 1,
    });
    messages.push({
      id: `a${index}`,
      role: "assistant",
      text:
        `Reply ${index}. ${"It is routed through the single runner, pattern-matched on structural fields, never on prompt text. ".repeat(3)}` +
        "\nPull up past the top to maximize; pull down from the top to restore.",
      timestamp: index * 2 + 2,
    });
  }
  return messages;
}

declare global {
  interface Window {
    __ELIZA_PERF_STREAM__?: (chars?: number) => void;
  }
}

function ProductionOverlay(): React.JSX.Element {
  const controller = useShellController();
  React.useLayoutEffect(() => controller.open(), [controller.open]);
  return <ChatOverlay controller={controller} />;
}

function Harness(): React.JSX.Element {
  const chat = useChatState();
  const [serverTurnStatus, setServerTurnStatus] =
    React.useState<ChatTurnStatus | null>(null);
  const ptySessionsRef = React.useRef<CodingAgentSession[]>([]);

  const send = useChatSend({
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: chat.state.activeConversationId,
    ptySessionsRef,
    setChatInput: chat.setChatInput,
    setChatSending: chat.setChatSending,
    setChatFirstTokenReceived: chat.setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage: chat.setChatLastUsage,
    setChatPendingImages: chat.setChatPendingImages,
    setConversations: chat.setConversations,
    setActiveConversationId: chat.setActiveConversationId,
    setCompanionMessageCutoffTs: chat.setCompanionMessageCutoffTs,
    setConversationMessages: chat.setConversationMessages,
    applyStreamingMessageModifications:
      chat.applyStreamingMessageModifications,
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

  // The transport is installed exactly once. All stateful collaborators below
  // are stable hook setters/refs, and the target conversation is explicit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: remounting the deterministic transport on each streaming render would restart the measured turn.
  React.useEffect(() => {
    const originalSend = client.sendConversationMessageStream;
    let streamedChars = 0;
    let accumulatedText = "";
    let settleStream: (() => void) | null = null;

    client.sendConversationMessageStream = (
      _conversationId,
      _text,
      onToken,
      _channelType,
      signal,
      _images,
      _metadata,
      _onStatus,
      _onToolEvent,
    ) =>
      new Promise((resolve) => {
        const settle = () => {
          resolve({
            text: accumulatedText,
            agentName: "elizaOS Perf",
            completed: false,
          });
        };
        settleStream = settle;
        signal?.addEventListener("abort", settle, { once: true });
        window.__ELIZA_PERF_STREAM__ = (chars = 1) => {
          streamedChars = Math.min(
            STREAMED_BODY.length,
            streamedChars + Math.max(0, chars),
          );
          accumulatedText =
            TAIL_WIDGET_PREFIX + STREAMED_BODY.slice(0, streamedChars);
          onToken("", accumulatedText);
        };
      });

    chat.setConversations([
      {
        id: CONVERSATION_ID,
        roomId: ROOM_ID,
        title: "Performance thread",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    chat.setActiveConversationId(CONVERSATION_ID);
    chat.setConversationMessages(longThread());
    void send.sendChatText("Measure the production stream.", {
      conversationId: CONVERSATION_ID,
    });

    return () => {
      window.__ELIZA_PERF_STREAM__ = undefined;
      settleStream?.();
      client.sendConversationMessageStream = originalSend;
    };
  }, []);

  const removeConversationMessage = React.useCallback(
    (messageId: string) => {
      chat.setConversationMessages((messages) =>
        messages.filter((message) => message.id !== messageId),
      );
    },
    [chat.setConversationMessages],
  );
  const composerValue = React.useMemo<ChatComposerValue>(
    () => ({
      chatInput: chat.state.chatInput,
      chatSending: chat.state.chatSending,
      chatPendingImages: chat.state.chatPendingImages,
      chatReplyTarget: chat.state.chatReplyTarget,
      setChatInput: chat.setChatInput,
      setChatPendingImages: chat.setChatPendingImages,
      setChatReplyTarget: chat.setChatReplyTarget,
    }),
    [chat],
  );
  const productionStreamContainsChoice =
    chat.state.conversationMessages.some(
      (message) =>
        message.role === "assistant" && message.text.includes("perf-choice"),
    );

  return (
    <MockAppProvider
      value={{
        tab: "chat",
        chatFirstTokenReceived: chat.state.chatFirstTokenReceived,
        sendChatText: send.sendChatText,
        agentStatus: {
          state: "running",
          agentName: "elizaOS Perf",
          model: "deterministic-stream",
          canRespond: true,
        },
        characterData: null,
        elizaCloudVoiceProxyAvailable: false,
        handleNewConversation: async () => {},
        handleSelectConversation: async () => {},
        activeConversationId: chat.state.activeConversationId,
        conversations: chat.state.conversations,
        setTab: () => {},
        handleChatStop: send.handleChatStop,
        setActionNotice: () => {},
        chatAgentVoiceMuted: false,
        setState: () => {},
      }}
    >
      <ConversationMessagesCtx.Provider
        value={{
          conversationMessages: chat.state.conversationMessages,
          removeConversationMessage,
          setConversationMessages: chat.setConversationMessages,
          prependConversationMessages: chat.prependConversationMessages,
        }}
      >
        <ChatComposerCtx.Provider value={composerValue}>
          <ChatTurnStatusCtx.Provider
            value={{ serverTurnStatus, setServerTurnStatus }}
          >
            <div
              data-testid="perf-gate-root"
              data-production-stream-contains-choice={
                productionStreamContainsChoice ? "true" : "false"
              }
              style={{
                position: "fixed",
                inset: 0,
                background: "#ef5a1f",
                color: "rgba(255,255,255,0.9)",
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "40px 24px", maxWidth: 640 }}>
                <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>
                  Workspace
                </h1>
                <p style={{ opacity: 0.7, marginTop: 10, lineHeight: 1.6 }}>
                  The floating chat below is the production chat state and shell
                  controller rendered through ChatOverlay.
                </p>
              </div>
              <ProductionOverlay />
            </div>
          </ChatTurnStatusCtx.Provider>
        </ChatComposerCtx.Provider>
      </ConversationMessagesCtx.Provider>
    </MockAppProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
