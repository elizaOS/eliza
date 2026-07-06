// Fixture for the #11670 warm-up eviction e2e. Mounts the REAL send pipeline
// (`useChatSend` — the unit the fix lives in) wired to the real
// ContinuousChatOverlay, with the warm-up condition simulated at the client-API
// boundary: `client.sendConversationMessageStream` 503s ("Agent is not
// running") until the harness flips `window.__setModelReady(true)`, and the
// history reload full-replaces local state with the scripted server truth —
// exactly what the production `loadConversationMessages` does. Paired with
// run-warmup-eviction-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Conversation, ConversationMessage } from "../../../api";
import { client } from "../../../api";
import { MockAppProvider } from "../../../storybook/mock-providers";
import type { UseChatSendDeps } from "../../../state/useChatSend";
import { useChatSend } from "../../../state/useChatSend";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import type { ShellMessage } from "../shell-state";
import type { ConversationNav, ShellController } from "../useShellController";

declare global {
  interface Window {
    __setModelReady?: (ready: boolean) => void;
  }
}

// ── Scripted server (the boundary) ─────────────────────────────────────────
// Mirrors the real agent's warm-up behavior: the runtime-ready hold expires →
// 503 with NOTHING persisted. Once ready, the turn persists and replies.

const serverThread: ConversationMessage[] = [];
let modelReady = false;
window.__setModelReady = (ready: boolean) => {
  console.log(`[fixture] modelReady -> ${ready}`);
  modelReady = ready;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CONVERSATION: Conversation = {
  id: "conv-1",
  roomId: "room-1",
  title: "New Chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Conversation;

client.sendConversationMessageStream = (async (
  _convId: string,
  text: string,
  onToken?: (token: string, accumulated?: string) => void,
) => {
  console.log(`[fixture] send "${text}" (modelReady=${modelReady})`);
  // Keep the optimistic bubble on screen long enough for a screenshot.
  await sleep(600);
  if (!modelReady) {
    // The runtime-ready gate gave up: nothing was persisted server-side.
    throw Object.assign(new Error("Agent is not running"), { status: 503 });
  }
  const reply = "I'm awake now — got your message.";
  const at = Date.now();
  serverThread.push(
    { id: `srv-u-${at}`, role: "user", text, timestamp: at },
    { id: `srv-a-${at}`, role: "assistant", text: reply, timestamp: at + 1 },
  );
  onToken?.(reply, reply);
  return { text: reply, completed: true };
}) as typeof client.sendConversationMessageStream;
client.sendWsMessage = (() => {}) as typeof client.sendWsMessage;
client.getBaseUrl = (() => "") as typeof client.getBaseUrl;
client.abortConversationTurn = async (roomId, reason = "ui-abort") => ({
  aborted: false,
  roomId,
  reason,
});
client.renameConversation = async () => ({ conversation: CONVERSATION });

// ── Harness ────────────────────────────────────────────────────────────────

function Harness(): React.JSX.Element {
  const [conversationMessages, setMessagesState] = React.useState<
    ConversationMessage[]
  >([]);
  const conversationMessagesRef = React.useRef<ConversationMessage[]>([]);
  const setConversationMessages = React.useCallback<
    UseChatSendDeps["setConversationMessages"]
  >((value) => {
    setMessagesState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      conversationMessagesRef.current = next;
      return next;
    });
  }, []);

  const [chatSending, setChatSending] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const conversationsRef = React.useRef<Conversation[]>([CONVERSATION]);
  const activeConversationIdRef = React.useRef<string | null>("conv-1");

  // The REAL full-replace semantics of loadConversationMessages: local state
  // becomes exactly the server truth (this is what evicts an unpersisted turn).
  const loadConversationMessages = React.useCallback(
    async (convId: string) => {
      console.log(
        `[fixture] reload ${convId}: server holds ${serverThread.length} messages`,
      );
      setConversationMessages([...serverThread]);
      return { ok: true as const };
    },
    [setConversationMessages],
  );

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: React.useRef([]),
    setChatInput: (value) => console.log(`[fixture] setChatInput "${value}"`),
    setChatSending,
    setChatFirstTokenReceived: () => {},
    setServerTurnStatus: () => {},
    setChatLastUsage: () => {},
    setChatPendingImages: () => {},
    setConversations: () => {},
    setActiveConversationId: () => {},
    setCompanionMessageCutoffTs: () => {},
    setConversationMessages,
    setUnreadConversations: () => {},
    setChatReplyTarget: () => {},
    setActionNotice: (text, tone) => {
      console.log(`[fixture] notice(${tone}): ${text}`);
      setNotice(text);
    },
    activeConversationIdRef,
    chatInputRef: React.useRef(""),
    chatPendingImagesRef: React.useRef([]),
    chatReplyTargetRef: React.useRef(null),
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: React.useRef(null),
    chatSendBusyRef: React.useRef(false),
    chatSendNonceRef: React.useRef(0),
    loadConversations: async () => conversationsRef.current,
    loadConversationMessages,
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: async () => true,
  };

  const { sendChatText } = useChatSend(deps);

  const messages = React.useMemo<ShellMessage[]>(
    () =>
      conversationMessages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.text,
        createdAt: message.timestamp,
        ...(message.failureKind ? { failureKind: message.failureKind } : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
      })),
    [conversationMessages],
  );

  const send = React.useCallback(
    (text: string) => {
      void sendChatText(text, { conversationId: "conv-1" });
    },
    [sendChatText],
  );

  const conversationNav = React.useMemo<ConversationNav>(
    () => ({
      hasPrev: false,
      hasNext: false,
      goPrev: () => {},
      goNext: () => {},
      activeId: "conv-1",
      index: 0,
    }),
    [],
  );

  const controller: ShellController = {
    phase: "summoned",
    responding: chatSending,
    turnStatus: chatSending ? { kind: "thinking" as const } : null,
    messages,
    canSend: true,
    recording: false,
    waveformMode: "idle",
    analyser: null,
    open: () => {},
    close: () => {},
    isOpen: true,
    handsFree: false,
    transcript: "",
    speaking: false,
    speak: () => {},
    stopSpeaking: () => {},
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    transcriptionMode: false,
    captureVision: () => {},
    visionCapturing: false,
    toggleTranscriptionMode: () => {},
    stopTranscriptionAndMic: () => {},
    modelStatus: {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    send,
    toggleRecording: () => {},
    toggleHandsFree: () => {},
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    startRecording: () => {},
    stopRecording: () => {},
    toggleAgentVoiceMute: () => {},
    unlockAudio: () => {},
    openSettings: () => {},
    navigateHome: () => {},
    clearConversation: () => {},
    stop: () => {},
    conversationNav,
  };

  return (
    <div
      data-testid="fake-view"
      style={{
        position: "fixed",
        inset: 0,
        background: "#ef5a1f",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "48px 28px", maxWidth: 720 }}>
        <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>
          Local model warming up…
        </h1>
        <p style={{ opacity: 0.7, marginTop: 12, lineHeight: 1.6 }}>
          The agent behind this fixture 503s every chat turn until the harness
          marks the model ready — the #11670 repro window.
        </p>
      </div>
      {notice ? (
        <div
          data-testid="fixture-notice"
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.75)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 12,
            padding: "10px 16px",
            fontSize: 13,
            zIndex: 100,
            maxWidth: 480,
          }}
        >
          {notice}
        </div>
      ) : null}
      <ContinuousChatOverlay controller={controller} />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <MockAppProvider>
      <Harness />
    </MockAppProvider>,
  );
