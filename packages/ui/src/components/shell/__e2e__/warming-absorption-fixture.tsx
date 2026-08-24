/**
 * Deterministic browser fixture for cache-warming send absorption and chat
 * history reconciliation. It mounts the real send and data-loader hooks over
 * one shared message store while simulating only the HTTP/SSE boundary.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

import type {
  Conversation,
  ConversationMessage,
  StreamEventEnvelope,
} from "../../../api";
import { client } from "../../../api";
import type {
  AutonomyEventStore,
  AutonomyRunHealthMap,
} from "../../../state/autonomy";
import type { UseChatSendDeps } from "../../../state/useChatSend";
import { useChatSend } from "../../../state/useChatSend";
import type { DataLoadersDeps } from "../../../state/useDataLoaders";
import { useDataLoaders } from "../../../state/useDataLoaders";
import { MockAppProvider } from "../../../storybook/mock-providers";
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

const MESSAGE = "first message to a fresh shared agent";
const REPLY = "Here — caches warmed while your send stayed pending.";
const OLDER_USER = "Earlier shared-agent question";
const OLDER_REPLY = "Earlier shared-agent answer";
const DURABLE_USER_ID = "srv-u-1";
const DURABLE_ASSISTANT_ID = "srv-a-1";
const CREDITS_MESSAGE =
  "You're out of credits. Add funds to keep chatting with your agent.";

const warmingSequence = ["agent_cache_warming", "shared_runtime_cache_warming"];

const FIXTURE_NOTICE_STYLE: React.CSSProperties = {
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
};

type StaleHistoryState = "idle" | "pending" | "released";
type RacePhase =
  | "inactive"
  | "loading-initial"
  | "stale-pending"
  | "stale-committed"
  | "converging"
  | "converged"
  | "error";

let streamPosts = 0;
let historyGets = 0;
let staleHistoryState: StaleHistoryState = "idle";
let resolveStaleHistory: (() => void) | null = null;
const streamClientMessageIds: string[] = [];
const fixtureSignalListeners = new Set<() => void>();

function publishFixtureSignals(): void {
  for (const listener of fixtureSignalListeners) listener();
}

function useFixtureSignals(): void {
  const [, setRevision] = React.useState(0);
  React.useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    fixtureSignalListeners.add(listener);
    return () => {
      fixtureSignalListeners.delete(listener);
    };
  }, []);
}

function olderHistory(): ConversationMessage[] {
  const now = Date.now();
  return [
    {
      id: "srv-u-older",
      role: "user",
      text: OLDER_USER,
      timestamp: now - 60_000,
    },
    {
      id: "srv-a-older",
      role: "assistant",
      text: OLDER_REPLY,
      timestamp: now - 59_000,
    },
  ];
}

function durableHistory(): ConversationMessage[] {
  const now = Date.now();
  return [
    ...olderHistory(),
    {
      id: DURABLE_USER_ID,
      role: "user",
      text: MESSAGE,
      timestamp: now - 1_000,
    },
    {
      id: DURABLE_ASSISTANT_ID,
      role: "assistant",
      text: REPLY,
      timestamp: now,
    },
  ];
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
    messageId: DURABLE_ASSISTANT_ID,
    userMessageId: DURABLE_USER_ID,
    ...(scenario === "warming" ? { historyRefreshRequired: true } : {}),
  });
  return new Response(`data: ${done}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function deferredStaleHistoryResponse(): Promise<Response> {
  staleHistoryState = "pending";
  publishFixtureSignals();
  return new Promise((resolve) => {
    resolveStaleHistory = () =>
      resolve(jsonResponse({ messages: olderHistory() }));
  });
}

function releaseDeferredStaleHistory(): void {
  const release = resolveStaleHistory;
  if (!release) return;
  resolveStaleHistory = null;
  staleHistoryState = "released";
  publishFixtureSignals();
  release();
}

client.setRequestTransport({
  async request(url, init) {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/messages/stream")) {
      streamPosts += 1;
      if (typeof init.body === "string") {
        const parsed = JSON.parse(init.body);
        if (typeof parsed.clientMessageId === "string") {
          streamClientMessageIds.push(parsed.clientMessageId);
        }
      }
      publishFixtureSignals();
      console.log(`[fixture] stream POST #${streamPosts} (${scenario})`);
      if (scenario === "credits") {
        return jsonResponse(
          { error: CREDITS_MESSAGE, code: "insufficient_credits" },
          402,
        );
      }
      const barrier = warmingSequence[streamPosts - 1];
      if (barrier) return warming503(barrier);
      return sseReply();
    }

    if (
      scenario === "rekey-race" &&
      method === "GET" &&
      url.includes("/api/conversations/conv-1/messages")
    ) {
      historyGets += 1;
      publishFixtureSignals();
      if (historyGets === 1) {
        return jsonResponse({ messages: olderHistory() });
      }
      if (historyGets === 2) return deferredStaleHistoryResponse();
      return jsonResponse({ messages: durableHistory() });
    }

    // Rename/PATCH and non-chat background probes are outside this fixture.
    return jsonResponse({});
  },
});
client.setBaseUrl("http://agent.example:2138", { persist: false });
client.sendWsMessage = (() => {}) as typeof client.sendWsMessage;

const noop = () => {};
const noopAsync = async () => {};

// ── Harness ────────────────────────────────────────────────────────────────

function Harness(): React.JSX.Element {
  useFixtureSignals();

  const [conversationMessages, setMessagesState] = React.useState<
    ConversationMessage[]
  >([]);
  const conversationMessagesRef = React.useRef<ConversationMessage[]>([]);
  const setConversationMessages = React.useCallback<
    UseChatSendDeps["setConversationMessages"]
  >((value) => {
    // Mirror useChatState's production contract: callbacks read and update the
    // ref synchronously before React schedules the visual state commit.
    const next =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
    conversationMessagesRef.current = next;
    setMessagesState(next);
  }, []);

  const conversationsRef = React.useRef<Conversation[]>([CONVERSATION]);
  const setConversations = React.useCallback<
    UseChatSendDeps["setConversations"]
  >((value) => {
    conversationsRef.current =
      typeof value === "function" ? value(conversationsRef.current) : value;
  }, []);
  const [activeConversationId, setActiveConversationIdState] = React.useState<
    string | null
  >("conv-1");
  const activeConversationIdRef = React.useRef<string | null>("conv-1");
  const setActiveConversationId = React.useCallback((value: string | null) => {
    activeConversationIdRef.current = value;
    setActiveConversationIdState(value);
  }, []);

  const autonomousStoreRef = React.useRef<AutonomyEventStore>({
    eventsById: {},
    eventOrder: [],
    runIndex: {},
    watermark: null,
  });
  const autonomousEventsRef = React.useRef<StreamEventEnvelope[]>([]);
  const autonomousLatestEventIdRef = React.useRef<string | null>(null);
  const autonomousRunHealthByRunIdRef = React.useRef<AutonomyRunHealthMap>({});
  const autonomousReplayInFlightRef = React.useRef(false);
  const greetingFiredRef = React.useRef(false);

  const dataLoaderDeps: DataLoadersDeps = {
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    setAutonomousEvents: noop,
    setAutonomousLatestEventId: noop,
    setAutonomousRunHealthByRunId: noop,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig: noopAsync,
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: noopAsync,
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noop,
  };
  const dataLoaders = useDataLoaders(dataLoaderDeps);

  const [racePhase, setRacePhase] = React.useState<RacePhase>(
    scenario === "rekey-race" ? "loading-initial" : "inactive",
  );
  const [raceError, setRaceError] = React.useState("");
  const raceStartedRef = React.useRef(false);

  React.useEffect(() => {
    if (scenario !== "rekey-race" || raceStartedRef.current) return;
    raceStartedRef.current = true;
    let cancelled = false;
    const startIndependentHistoryLoad = async () => {
      const initial = await dataLoaders.loadConversationMessages("conv-1");
      if (!initial.ok) {
        throw new Error(initial.message ?? "initial history load failed");
      }
      if (cancelled) return;
      const staleLoad = dataLoaders.loadConversationMessages("conv-1");
      setRacePhase("stale-pending");
      const stale = await staleLoad;
      if (!stale.ok) {
        throw new Error(stale.message ?? "stale history load failed");
      }
      if (!cancelled) setRacePhase("stale-committed");
    };
    void startIndependentHistoryLoad().catch((error: unknown) => {
      // error-policy:J1 the harness publishes loader failures for the browser
      // runner to fail with a precise fixture phase instead of timing out.
      if (cancelled) return;
      setRaceError(error instanceof Error ? error.message : String(error));
      setRacePhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [dataLoaders.loadConversationMessages]);

  const convergeDurableHistory = React.useCallback(async () => {
    if (scenario !== "rekey-race") return;
    setRacePhase("converging");
    const result = await dataLoaders.loadConversationMessages("conv-1");
    if (!result.ok) {
      setRaceError(result.message ?? "durable history load failed");
      setRacePhase("error");
      return;
    }
    setRacePhase("converged");
  }, [dataLoaders.loadConversationMessages]);

  const [chatSending, setChatSending] = React.useState(false);
  const [turnStatus, setTurnStatus] = React.useState<{
    kind: "waking" | "thinking";
  } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const loadConversationMessagesForSend = React.useCallback(async () => {
    if (scenario === "warming") {
      setConversationMessages(olderHistory());
    }
    return { ok: true as const };
  }, [setConversationMessages]);

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId,
    ptySessionsRef: React.useRef([]),
    setChatInput: () => {},
    setChatSending,
    setChatFirstTokenReceived: () => {},
    setServerTurnStatus: (status) =>
      setTurnStatus(status as { kind: "waking" | "thinking" } | null),
    setChatLastUsage: () => {},
    setChatPendingImages: () => {},
    setConversations,
    setActiveConversationId,
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
    loadConversationMessages:
      scenario === "rekey-race"
        ? dataLoaders.loadConversationMessages
        : loadConversationMessagesForSend,
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
      if (scenario === "rekey-race" && racePhase !== "stale-pending") return;
      void sendChatText(text, { conversationId: "conv-1" });
    },
    [racePhase, sendChatText],
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
    authGate: { gated: false, phase: "clear" },
    requestSignIn: () => {},
    signingIn: false,
    responding: chatSending,
    turnStatus:
      turnStatus ?? (chatSending ? { kind: "thinking" as const } : null),
    messages,
    canSend: scenario !== "rekey-race" || racePhase === "stale-pending",
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
    cancelRecording: () => {},
    toggleAgentVoiceMute: () => {},
    unlockAudio: () => {},
    openSettings: () => {},
    navigateHome: () => {},
    clearConversation: () => {},
    stop: () => {},
    conversationNav,
  };

  const turnUsers = conversationMessages.filter(
    (message) => message.role === "user" && message.text === MESSAGE,
  );
  const turnAssistants = conversationMessages.filter(
    (message) => message.role === "assistant" && message.text === REPLY,
  );

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
      <div
        data-testid="fixture-signals"
        data-scenario={scenario}
        data-race-phase={racePhase}
        data-race-error={raceError}
        data-stream-posts={String(streamPosts)}
        data-client-message-ids={JSON.stringify(streamClientMessageIds)}
        data-history-gets={String(historyGets)}
        data-stale-history-state={staleHistoryState}
        data-message-ids={JSON.stringify(
          conversationMessages.map((message) => message.id),
        )}
        data-turn-user-count={String(turnUsers.length)}
        data-turn-assistant-count={String(turnAssistants.length)}
        data-turn-user-id={turnUsers[0]?.id ?? ""}
        data-turn-assistant-id={turnAssistants[0]?.id ?? ""}
        hidden
      />
      <button
        type="button"
        data-testid="fixture-release-stale-history"
        onClick={releaseDeferredStaleHistory}
        hidden
      />
      <button
        type="button"
        data-testid="fixture-converge-durable-history"
        onClick={() => void convergeDurableHistory()}
        hidden
      />
      <div style={{ padding: "48px 28px", maxWidth: 720 }}>
        <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>
          First shared-agent turn
        </h1>
        <p style={{ opacity: 0.7, marginTop: 12, lineHeight: 1.6 }}>
          {scenario === "credits"
            ? "The fixture answers with the canonical insufficient_credits 402."
            : scenario === "rekey-race"
              ? "An independent stale history request resolves after the streamed turn receives durable ids."
              : "The fixture absorbs both named warming barriers, replies, then temporarily sees stale history."}
        </p>
      </div>
      {notice ? (
        <div data-testid="fixture-notice" style={FIXTURE_NOTICE_STYLE}>
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
