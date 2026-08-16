// Fixture for the #18045 first-shared-turn warming-absorption e2e. Mounts the
// REAL send pipeline — `useChatSend` → `streamChatEndpoint` → `rawRequest`,
// where the bounded warming-503 absorption lives — wired to the real
// ChatOverlay, with the server simulated at the TRANSPORT boundary
// (`client.setRequestTransport`) so the production retry loop, SSE parsing,
// and error classification all execute in a real browser. Scenarios via
// `?scenario=`: default replays the issue's exact first-turn sequence
// (`agent_cache_warming` 503 → `shared_runtime_cache_warming` 503 → reply);
// `credits` answers the send with the canonical `insufficient_credits` 402.
// Paired with run-warming-absorption-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Conversation, ConversationMessage } from "../../../api";
import { client } from "../../../api";
import type { UseChatSendDeps } from "../../../state/useChatSend";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { useChatSend } from "../../../state/useChatSend";
import { ChatOverlay } from "../ChatOverlay";
import type { ShellMessage } from "../shell-state";
import type { ConversationNav, ShellController } from "../useShellController";

const scenario =
  new URLSearchParams(window.location.search).get("scenario") ?? "warming";

const CONVERSATION: Conversation = {
  id: "conv-1",
  roomId: "room-1",
  title: "New Chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Conversation;

// ── Scripted server (the transport boundary) ───────────────────────────────
// Mirrors the staging repro from #18045: the first POST to the messages
// stream hits the authorization-scope warming barrier, the second hits the
// shared-runtime warming barrier — each a 503 with a stable code and
// `Retry-After: 1` — and the third attempt streams the real first reply.

const REPLY = "Here — caches warmed while your send stayed pending.";
const CREDITS_MESSAGE =
  "You're out of credits. Add funds to keep chatting with your agent.";

const warmingSequence = ["agent_cache_warming", "shared_runtime_cache_warming"];
let streamPosts = 0;

function warming503(code: string): Response {
  return new Response(
    JSON.stringify({
      error: "Cache is warming. Retry shortly.",
      code,
      retryable: true,
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "1" },
    },
  );
}

function sseReply(): Response {
  const done = JSON.stringify({
    type: "done",
    fullText: REPLY,
    agentName: "Eliza",
    messageId: "srv-a-1",
    userMessageId: "srv-u-1",
  });
  return new Response(`data: ${done}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

client.setRequestTransport({
  async request(url, init) {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/messages/stream")) {
      streamPosts += 1;
      console.log(`[fixture] stream POST #${streamPosts} (${scenario})`);
      if (scenario === "credits") {
        return new Response(
          JSON.stringify({
            error: CREDITS_MESSAGE,
            code: "insufficient_credits",
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      const barrier = warmingSequence[streamPosts - 1];
      if (barrier) return warming503(barrier);
      return sseReply();
    }
    // Rename/PATCH and any background probe: succeed quietly.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
client.setBaseUrl("http://agent.example:2138", { persist: false });
client.sendWsMessage = (() => {}) as typeof client.sendWsMessage;

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
  const [turnStatus, setTurnStatus] = React.useState<{
    kind: "waking" | "thinking";
  } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const conversationsRef = React.useRef<Conversation[]>([CONVERSATION]);
  const activeConversationIdRef = React.useRef<string | null>("conv-1");

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: React.useRef([]),
    setChatInput: () => {},
    setChatSending,
    setChatFirstTokenReceived: () => {},
    setServerTurnStatus: (status) =>
      setTurnStatus(status as { kind: "waking" | "thinking" } | null),
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
    loadConversationMessages: async () => ({ ok: true as const }),
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
    turnStatus: turnStatus ?? (chatSending ? { kind: "thinking" as const } : null),
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
    micPermission: "unknown",
    recheckMicPermission: async () => "unknown",
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
          First shared-agent turn
        </h1>
        <p style={{ opacity: 0.7, marginTop: 12, lineHeight: 1.6 }}>
          {scenario === "credits"
            ? "The agent behind this fixture answers the send with the canonical insufficient_credits 402."
            : "The agent behind this fixture 503s the first two sends with the named warming barriers, then replies — the #18045 repro sequence."}
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
      <ChatOverlay controller={controller} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root missing");
createRoot(rootEl).render(
  <MockAppProvider>
    <Harness />
  </MockAppProvider>,
);
