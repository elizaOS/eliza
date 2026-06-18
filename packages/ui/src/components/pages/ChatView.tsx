import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type CodingAgentSession, client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import { fetchWithCsrf } from "../../api/csrf-client";
import { isRoutineCodingAgentMessage } from "../../chat";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import { useChatAvatarVoiceBridge } from "../../hooks/useChatAvatarVoiceBridge";
import { useConnectorSendAsAccount } from "../../hooks/useConnectorSendAsAccount";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { consumeAssistantLaunchPayloadFromHash } from "../../platform/assistant-launch-payload";
import {
  CodingAgentControlChip,
  PtyConsoleBase,
} from "../../slots/task-coordinator-slots.js";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { usePtySessions } from "../../state/PtySessionsContext.hooks";
import {
  loadContinuousChatMode,
  saveContinuousChatMode,
} from "../../state/persistence";
import { useApp } from "../../state/useApp";
import { getVrmPreviewUrl } from "../../state/vrm";
import type { TranslateFn } from "../../types";
import {
  filesToImageAttachments,
  MAX_CHAT_IMAGES,
} from "../../utils/image-attachment";
import type { VoiceContinuousMode } from "../../voice/voice-chat-types";
import { AccountRequiredCard } from "../chat/AccountRequiredCard";
import { AgentActivityBox } from "../chat/AgentActivityBox";
import { ConnectorAccountPicker } from "../chat/ConnectorAccountPicker";
import {
  connectorAccountDisplayName,
  connectorWriteConfirmationKey,
  isLikelyAccountRequiredError,
  mergeConnectorSendAsMetadata,
} from "../chat/connector-send-as";
import { MessageContent } from "../chat/MessageContent";
import { ChatVoiceStatusBar } from "../composites/chat/ChatVoiceStatusBar";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import { ChatAttachmentStrip } from "../composites/chat/chat-attachment-strip";
import { ChatComposer } from "../composites/chat/chat-composer";
import { ChatComposerShell } from "../composites/chat/chat-composer-shell";
import { ChatEmptyState } from "../composites/chat/chat-empty-state";
import { ChatSourceIcon } from "../composites/chat/chat-source";
import { ChatThreadLayout } from "../composites/chat/chat-thread-layout";
import { ChatTranscript } from "../composites/chat/chat-transcript";
import { TypingIndicator } from "../composites/chat/chat-typing-indicator";
import {
  useChatVoiceController,
  useGameModalMessages,
} from "./chat-view-hooks";

const CHAT_INPUT_MIN_HEIGHT_PX = 46;
const CHAT_INPUT_MAX_HEIGHT_PX = 200;
/** Hide the typing indicator if no first token arrives within this window. */
const TYPING_INDICATOR_STALL_MS = 30_000;
const fallbackTranslate: TranslateFn = (key, options) =>
  typeof options?.defaultValue === "string" ? options.defaultValue : key;

type ChatViewVariant = "default" | "game-modal";
type InboxChatSelection = {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  source: string;
  title: string;
  transportSource?: string;
  worldId?: string;
  worldLabel?: string;
};

interface ChatViewProps {
  variant?: ChatViewVariant;
  /** Override click handler for agent activity box sessions. */
  onPtySessionClick?: (sessionId: string) => void;
  /**
   * Hide the in-view composer. Used on the chat tab when the always-present
   * ContinuousChatOverlay provides the (single, shared) input instead, so there
   * is no duplicate composer. The transcript and side panels still render.
   */
  hideComposer?: boolean;
}

function normalizeInboxChatSelection(
  value: unknown,
): InboxChatSelection | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const title =
    typeof candidate.title === "string" ? candidate.title.trim() : "";
  const source =
    typeof candidate.source === "string" ? candidate.source.trim() : "";
  const transportSource =
    typeof candidate.transportSource === "string" &&
    candidate.transportSource.trim().length > 0
      ? candidate.transportSource.trim()
      : undefined;

  if (!id || !title || (!source && !transportSource)) {
    return null;
  }

  return {
    avatarUrl:
      typeof candidate.avatarUrl === "string" ? candidate.avatarUrl : undefined,
    canSend:
      typeof candidate.canSend === "boolean" ? candidate.canSend : undefined,
    id,
    source,
    title,
    transportSource,
    worldId:
      typeof candidate.worldId === "string" ? candidate.worldId : undefined,
    worldLabel:
      typeof candidate.worldLabel === "string"
        ? candidate.worldLabel
        : undefined,
  };
}

export function ChatView({
  variant = "default",
  onPtySessionClick,
  hideComposer = false,
}: ChatViewProps) {
  const app = useApp();
  const isGameModal = variant === "game-modal";
  const showComposerVoiceToggle = false;
  const {
    agentStatus,
    activeConversationId,
    activeInboxChat,
    activeTerminalSessionId,
    characterData,
    chatFirstTokenReceived,
    companionMessageCutoffTs,
    conversationMessages,
    handleChatSend,
    handleChatStop,
    handleChatEdit,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
    elizaCloudHasPersistedKey,
    setState,
    copyToClipboard,
    droppedFiles: rawDroppedFiles,
    analysisMode,
    shareIngestNotice: rawShareIngestNotice,
    chatAgentVoiceMuted: agentVoiceMuted,
    selectedVrmIndex,
    uiLanguage,
    sendChatText,
    t: appTranslate,
  } = app;
  const { ptySessions } = usePtySessions();
  const {
    chatInput: rawChatInput,
    chatSending,
    chatPendingImages: rawChatPendingImages,
    setChatInput,
    setChatPendingImages,
  } = useChatComposer();
  const droppedFiles = Array.isArray(rawDroppedFiles) ? rawDroppedFiles : [];
  const chatInput = typeof rawChatInput === "string" ? rawChatInput : "";
  const shareIngestNotice =
    typeof rawShareIngestNotice === "string" ? rawShareIngestNotice : "";
  const chatPendingImages = Array.isArray(rawChatPendingImages)
    ? rawChatPendingImages
    : [];
  const inboxChat = useMemo(
    () => normalizeInboxChatSelection(activeInboxChat),
    [activeInboxChat],
  );

  const t = useCallback(
    (key: string, values?: Record<string, unknown>) => {
      if (typeof appTranslate === "function") {
        return appTranslate(key, values);
      }

      const template =
        typeof values?.defaultValue === "string" ? values.defaultValue : key;

      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
        const value = values?.[token];
        return value == null ? "" : String(value);
      });
    },
    [appTranslate],
  );

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [imageDragOver, setImageDragOver] = useState(false);
  // Guards the "thinking" typing indicator: if the first token never arrives,
  // we hide the dots after a timeout rather than spinning forever. Reset
  // whenever a new send starts or the first token lands (normal stream path).
  const [typingStalled, setTypingStalled] = useState(false);
  const [continuousChatMode, setContinuousChatMode] =
    useState<VoiceContinuousMode>(loadContinuousChatMode);
  const handleContinuousChatModeChange = useCallback(
    (next: VoiceContinuousMode) => {
      setContinuousChatMode(next);
      saveContinuousChatMode(next);
    },
    [],
  );

  useEffect(() => {
    if (isGameModal || typeof window === "undefined") return;

    const consumeLaunchPayload = () => {
      void consumeAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
        onSendFailure: (payload) => {
          setChatInput(payload.text);
        },
        sendText: sendChatText,
      });
    };

    consumeLaunchPayload();
    window.addEventListener("hashchange", consumeLaunchPayload);
    return () => {
      window.removeEventListener("hashchange", consumeLaunchPayload);
    };
  }, [isGameModal, sendChatText, setChatInput]);

  const focusTerminalSession = useCallback(
    (sessionId: string) => {
      setState("activeInboxChat", null);
      setState("activeTerminalSessionId", sessionId);
    },
    [setState],
  );

  // Route a problem session into the Terminal channel so the user sees it.
  useEffect(() => {
    if (activeTerminalSessionId) return;
    const problemSession = ptySessions.find(
      (s) => s.status === "error" || s.status === "blocked",
    );
    if (problemSession) {
      focusTerminalSession(problemSession.sessionId);
    }
  }, [ptySessions, activeTerminalSessionId, focusTerminalSession]);

  // ── Coding agent preflight ──────────────────────────────────────
  // Only fire once the agent runtime is confirmed running so we don't hit the
  // orchestrator/ACP routes during the brief post-boot window when services are
  // still completing their async init (they return 503 until ready, and the
  // browser logs those as red console errors even when the JS .catch swallows them).
  const agentRunning = agentStatus?.state === "running";
  const [codingAgentsAvailable, setCodingAgentsAvailable] = useState(false);
  useEffect(() => {
    if (!agentRunning) return;
    const controller = new AbortController();
    fetchWithCsrf("/api/coding-agents/preflight", { signal: controller.signal })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) {
          setCodingAgentsAvailable(
            data.some(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as { installed?: unknown }).installed === true,
            ),
          );
          return;
        }
        const status = data as { installed?: unknown[]; available?: boolean };
        setCodingAgentsAvailable(
          (Array.isArray(status.installed) && status.installed.length > 0) ||
            status.available === true,
        );
      })
      .catch(() => {
        /* preflight unavailable or aborted — hide code button */
      });
    return () => controller.abort();
  }, [agentRunning]);

  const handleCreateTask = useCallback(
    (description: string, agentType: string) => {
      void sendChatText(description, {
        metadata: { intent: "create_task", agentType },
      });
    },
    [sendChatText],
  );

  // ── Derived composer state ──────────────────────────────────────
  const isAgentStarting =
    agentStatus?.state === "starting" || agentStatus?.state === "restarting";
  // The agent is up but has no inference model wired — no point letting the
  // user hit send. Surfaced as a composer lock + a pointer to Settings.
  const agentModel =
    typeof agentStatus?.model === "string" ? agentStatus.model.trim() : "";
  const isMobileLocalRuntime = readPersistedMobileRuntimeMode() === "local";
  const isMissingInferenceProvider =
    agentStatus?.state === "running" &&
    agentModel.length === 0 &&
    !isMobileLocalRuntime;
  // First-turn capability fades in: the composer stays usable while the agent
  // warms up (a turn submitted during warmup is held server-side until the
  // runtime is ready, then streams its reply) — only a genuinely missing
  // inference provider hard-locks the composer.
  const isComposerLocked = isMissingInferenceProvider;
  const composerPlaceholderOverride = isMissingInferenceProvider
    ? t("chat.setupProviderToChat", {
        defaultValue: "Set up an LLM provider in Settings to start chatting",
      })
    : undefined;
  const {
    beginVoiceCapture,
    endVoiceCapture,
    continuous,
    handleEditMessage,
    handleSpeakMessage,
    stopSpeaking,
    voice,
    voiceLatency,
    voiceSpeaker,
  } = useChatVoiceController({
    agentVoiceMuted,
    chatFirstTokenReceived,
    chatInput,
    chatSending,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
    elizaCloudHasPersistedKey,
    conversationMessages,
    activeConversationId,
    handleChatEdit,
    handleChatSend,
    isComposerLocked,
    isGameModal,
    setState,
    uiLanguage,
    continuousMode: continuousChatMode,
  });
  // Stop any in-flight voice playback when the user switches conversations.
  // useLayoutEffect (not useEffect): must run *before* useChatVoiceController's
  // passive auto-speak effect. Otherwise we queue the new thread's greeting
  // first, then stopSpeaking() clears that queue — no TTS after new chat/reset.
  const prevConversationIdRef = useRef(activeConversationId);
  useLayoutEffect(() => {
    if (prevConversationIdRef.current === activeConversationId) return;
    prevConversationIdRef.current = activeConversationId;
    stopSpeaking();
  }, [activeConversationId, stopSpeaking]);

  const handleChatAvatarSpeakingChange = useCallback(
    (isSpeaking: boolean) => {
      setState("chatAvatarSpeaking", isSpeaking);
    },
    [setState],
  );

  const agentName =
    characterData?.name ||
    agentStatus?.agentName ||
    t("common.agent", { defaultValue: "Agent" });
  const msgs = Array.isArray(conversationMessages) ? conversationMessages : [];
  const visibleMsgs = useMemo(
    () =>
      msgs
        .filter(
          (msg) =>
            !(
              chatSending &&
              !chatFirstTokenReceived &&
              msg.role === "assistant" &&
              !msg.text.trim()
            ) && !isRoutineCodingAgentMessage(msg),
        )
        // Default-tag any message that arrived without a source as
        // "eliza" so dashboard turns render the gold chip symmetric
        // with connector messages. Live-streamed turns flow through
        // the SSE path and don't carry the server-side default from
        // conversation-routes.ts, so we catch them here too.
        .map((msg) => (msg.source ? msg : { ...msg, source: "eliza" })),
    [chatFirstTokenReceived, chatSending, msgs],
  );
  const {
    companionCarryover,
    gameModalCarryoverOpacity,
    gameModalVisibleMsgs,
  } = useGameModalMessages({
    activeConversationId,
    companionMessageCutoffTs,
    isGameModal,
    visibleMsgs,
  });
  const agentAvatarSrc =
    selectedVrmIndex > 0 ? getVrmPreviewUrl(selectedVrmIndex) : null;

  useChatAvatarVoiceBridge({
    mouthOpen: voice.mouthOpen,
    isSpeaking: voice.isSpeaking,
    onSpeakingChange: handleChatAvatarSpeakingChange,
  });

  // Auto-scroll on new messages. Use instant scroll when already near the
  // bottom (or when the user is actively sending) to prevent the visible
  // "scroll from top" effect that occurs when many background messages
  // (e.g. coding-agent updates) arrive in rapid succession during smooth
  // scrolling. Only smooth-scroll when the user has scrolled up and a new
  // message nudges them back down.
  useEffect(() => {
    const displayedCompanionMessageCount =
      (companionCarryover?.messages.length ?? 0) + gameModalVisibleMsgs.length;
    if (
      !chatSending &&
      visibleMsgs.length === 0 &&
      (!isGameModal || displayedCompanionMessageCount === 0)
    ) {
      return;
    }
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 150;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: nearBottom ? "instant" : "smooth",
    });
  }, [
    chatSending,
    companionCarryover,
    gameModalVisibleMsgs,
    isGameModal,
    visibleMsgs,
  ]);

  // Auto-resize textarea
  useEffect(() => {
    if (!isGameModal) return;
    const ta = textareaRef.current;
    if (!ta) return;

    // Force a compact baseline when empty so the composer never boots oversized.
    if (!chatInput) {
      ta.style.height = `${CHAT_INPUT_MIN_HEIGHT_PX}px`;
      ta.style.overflowY = "hidden";
      return;
    }

    ta.style.height = "auto";
    ta.style.overflowY = "hidden";
    const h = Math.min(ta.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX);
    ta.style.height = `${h}px`;
    ta.style.overflowY =
      ta.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [chatInput, isGameModal]);

  // Track composer height so the message layer bottom adjusts dynamically
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setComposerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Typing-indicator stall guard. While a send is in flight with no first token
  // yet, arm a timer; if it fires, the request is stuck (e.g. provider hang) so
  // we drop the indicator. Once the first token lands or the send settles the
  // gate clears, the timer is torn down, and the flag resets — the normal
  // streaming path never trips it.
  useEffect(() => {
    if (!chatSending || chatFirstTokenReceived) {
      setTypingStalled(false);
      return;
    }
    const timer = setTimeout(
      () => setTypingStalled(true),
      TYPING_INDICATOR_STALL_MS,
    );
    return () => clearTimeout(timer);
  }, [chatSending, chatFirstTokenReceived]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerLocked) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleChatSend();
    }
  };

  const addImageFiles = useCallback(
    (files: FileList | File[]) => {
      void filesToImageAttachments(files)
        .then((attachments) => {
          if (!attachments.length) return;
          setChatPendingImages((prev) =>
            [...prev, ...attachments].slice(0, MAX_CHAT_IMAGES),
          );
        })
        .catch((err: unknown) => {
          // A failed image read leaves nothing attached; tell the user rather
          // than silently dropping their image.
          app.setActionNotice?.(
            app.t("chatview.ImageReadFailed", {
              message: err instanceof Error ? err.message : "unknown error",
              defaultValue: "Couldn't read image: {{message}}",
            }),
            "error",
          );
        });
    },
    [app, setChatPendingImages],
  );

  const handleImageDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setImageDragOver(false);
      if (e.dataTransfer.files.length) {
        addImageFiles(e.dataTransfer.files);
      }
    },
    [addImageFiles],
  );

  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addImageFiles(e.target.files);
      }
      e.target.value = "";
    },
    [addImageFiles],
  );

  const removeImage = useCallback(
    (index: number) => {
      setChatPendingImages((prev) => prev.filter((_, i) => i !== index));
    },
    [setChatPendingImages],
  );

  const chatMessageLabels = {
    cancel: t("common.cancel"),
    delete: t("aria.deleteMessage"),
    edit: t("aria.editMessage"),
    play: t("aria.playMessage"),
    responseInterrupted: t("chatmessage.ResponseInterrupte"),
    saveAndResend: t("chatmessage.SaveAndResend", {
      defaultValue: "Save and resend",
    }),
    saving: t("common.saving", {
      defaultValue: "Saving...",
    }),
  };

  const messagesContent =
    visibleMsgs.length === 0 && !chatSending ? (
      <ChatEmptyState
        agentName={agentName}
        variant={variant}
        onSuggestionClick={(suggestion) => setChatInput(suggestion)}
      />
    ) : (
      <ChatTranscript
        variant={variant}
        agentName={agentName}
        carryoverMessages={companionCarryover?.messages}
        carryoverOpacity={gameModalCarryoverOpacity}
        labels={chatMessageLabels}
        messages={isGameModal ? gameModalVisibleMsgs : visibleMsgs}
        onEdit={handleEditMessage}
        onSpeak={handleSpeakMessage}
        onCopy={(text) => {
          void copyToClipboard(text);
        }}
        renderMessageContent={(message) => (
          <MessageContent
            message={message as ConversationMessage}
            analysisMode={analysisMode}
          />
        )}
        typingIndicator={
          chatSending && !chatFirstTokenReceived && !typingStalled ? (
            isGameModal ? (
              <TypingIndicator variant="game-modal" agentName={agentName} />
            ) : (
              <TypingIndicator
                agentName={agentName}
                agentAvatarSrc={agentAvatarSrc}
              />
            )
          ) : null
        }
      />
    );

  const voiceStatusBarVisible =
    voice.supported &&
    (continuousChatMode !== "off" ||
      voice.isListening ||
      voice.isSpeaking ||
      Boolean(voiceSpeaker) ||
      Boolean(continuous.interimTranscript));
  const continuousChatToggleVisible =
    voice.supported && continuousChatMode !== "off";

  const auxiliaryNode = (
    <>
      {voiceStatusBarVisible ? (
        <ChatVoiceStatusBar
          status={continuous.status}
          interimTranscript={continuous.interimTranscript}
          speaker={voiceSpeaker}
          latency={continuous.latency}
          needsAudioUnlock={continuous.needsAudioUnlock}
          onUnlockAudio={continuous.unlockAudio}
          micReconnected={continuous.micReconnected}
          visible
          className={`mb-1 relative${isGameModal ? " pointer-events-auto" : ""}`}
          data-testid="chat-view-voice-status-bar"
        />
      ) : null}
      {shareIngestNotice ? (
        <div
          className={`text-xs text-ok py-1 relative${isGameModal ? " pointer-events-auto" : ""}`}
          style={{ zIndex: 1 }}
        >
          {shareIngestNotice}
        </div>
      ) : null}
      {droppedFiles.length > 0 ? (
        <div
          className={`text-xs text-muted py-0.5 flex gap-2 relative${isGameModal ? " pointer-events-auto" : ""}`}
          style={{ zIndex: 1 }}
        >
          {droppedFiles.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      ) : null}
      <ChatAttachmentStrip
        variant={variant}
        items={chatPendingImages.map((img, imgIdx) => ({
          id: String(imgIdx),
          alt: img.name,
          name: img.name,
          src: `data:${img.mimeType};base64,${img.data}`,
        }))}
        removeLabel={(item) =>
          t("chat.removeImage", {
            defaultValue: "Remove image {{name}}",
            name: item.name,
          })
        }
        onRemove={(id) => removeImage(Number(id))}
      />
      {voiceLatency ? (
        <div
          className={`pb-1 text-2xs text-muted relative${isGameModal ? " pointer-events-auto" : ""}`}
          style={{ zIndex: 1 }}
        >
          {t("chatview.SilenceEndFirstTo")}{" "}
          {voiceLatency.speechEndToFirstTokenMs ?? "—"}
          {t("chatview.msEndVoiceStart")}{" "}
          {voiceLatency.speechEndToVoiceStartMs ?? "—"}
          {t("chatview.msFirst")}{" "}
          {voiceLatency.firstSegmentCached == null
            ? "—"
            : voiceLatency.firstSegmentCached
              ? t("chat.cached", { defaultValue: "cached" })
              : t("chat.uncached", { defaultValue: "uncached" })}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
    </>
  );

  const defaultComposerLaneClassName =
    "mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8 xl:px-10";
  const defaultComposerShellClassName = `${defaultComposerLaneClassName} pt-1.5`;
  const defaultComposerShellStyle = {
    paddingBottom:
      "calc(var(--safe-area-bottom, 0px) + var(--eliza-mobile-nav-offset, 0px) + 0.375rem)",
  } as const;

  const composerNode = hideComposer ? null : isGameModal ? (
    <ChatComposerShell
      variant="game-modal"
      shellRef={composerRef}
      before={
        <>
          <CodingAgentControlChip />
          {continuousChatToggleVisible ? (
            <div className="flex justify-end px-1 pb-0.5">
              <ContinuousChatToggle
                compact
                value={continuousChatMode}
                onChange={handleContinuousChatModeChange}
                disabled={isComposerLocked}
                data-testid="chat-view-continuous-chat-toggle-game-modal"
              />
            </div>
          ) : null}
          <AgentActivityBox
            sessions={ptySessions}
            onSessionClick={onPtySessionClick ?? focusTerminalSession}
          />
        </>
      }
    >
      <ChatComposer
        variant="game-modal"
        textareaRef={textareaRef}
        chatInput={chatInput}
        chatPendingImagesCount={chatPendingImages.length}
        isComposerLocked={isComposerLocked}
        isAgentStarting={isAgentStarting}
        placeholder={composerPlaceholderOverride}
        chatSending={chatSending}
        voice={{
          supported: voice.supported,
          isListening: voice.isListening,
          captureMode: voice.captureMode,
          interimTranscript: voice.interimTranscript,
          isSpeaking: voice.isSpeaking,
          assistantTtsQuality: voice.assistantTtsQuality,
          toggleListening: voice.toggleListening,
          startListening: beginVoiceCapture,
          stopListening: endVoiceCapture,
        }}
        agentVoiceEnabled={!agentVoiceMuted}
        showAgentVoiceToggle={showComposerVoiceToggle}
        t={t}
        onAttachImage={() => fileInputRef.current?.click()}
        onChatInputChange={(value) => setState("chatInput", value)}
        onKeyDown={handleKeyDown}
        onSend={() => void handleChatSend()}
        onStop={handleChatStop}
        onStopSpeaking={stopSpeaking}
        onToggleAgentVoice={() =>
          setState("chatAgentVoiceMuted", !agentVoiceMuted)
        }
        codingAgentsAvailable={codingAgentsAvailable}
        onCreateTask={handleCreateTask}
      />
    </ChatComposerShell>
  ) : (
    <ChatComposerShell
      variant="default"
      className={defaultComposerShellClassName}
      style={defaultComposerShellStyle}
      before={
        <>
          <CodingAgentControlChip />
          {continuousChatToggleVisible ? (
            <div className="flex justify-end px-1 pb-0.5">
              <ContinuousChatToggle
                compact
                value={continuousChatMode}
                onChange={handleContinuousChatModeChange}
                disabled={isComposerLocked}
                data-testid="chat-view-continuous-chat-toggle"
              />
            </div>
          ) : null}
        </>
      }
    >
      <ChatComposer
        variant="default"
        layout="inline"
        textareaRef={textareaRef}
        chatInput={chatInput}
        chatPendingImagesCount={chatPendingImages.length}
        isComposerLocked={isComposerLocked}
        isAgentStarting={isAgentStarting}
        placeholder={composerPlaceholderOverride}
        chatSending={chatSending}
        voice={{
          supported: voice.supported,
          isListening: voice.isListening,
          captureMode: voice.captureMode,
          interimTranscript: voice.interimTranscript,
          isSpeaking: voice.isSpeaking,
          assistantTtsQuality: voice.assistantTtsQuality,
          toggleListening: voice.toggleListening,
          startListening: beginVoiceCapture,
          stopListening: endVoiceCapture,
        }}
        agentVoiceEnabled={!agentVoiceMuted}
        showAgentVoiceToggle={showComposerVoiceToggle}
        t={t}
        onAttachImage={() => fileInputRef.current?.click()}
        onChatInputChange={(value) => setState("chatInput", value)}
        onKeyDown={handleKeyDown}
        onSend={() => void handleChatSend()}
        onStop={handleChatStop}
        onStopSpeaking={stopSpeaking}
        onToggleAgentVoice={() =>
          setState("chatAgentVoiceMuted", !agentVoiceMuted)
        }
        codingAgentsAvailable={codingAgentsAvailable}
        onCreateTask={handleCreateTask}
      />
    </ChatComposerShell>
  );

  // ── Terminal-channel branch ──────────────────────────────────────
  if (activeTerminalSessionId) {
    return (
      <TerminalChannelPanel
        activeSessionId={activeTerminalSessionId}
        sessions={ptySessions}
        onClose={() => setState("activeTerminalSessionId", null)}
        loadingLabel={t("terminal.starting", {
          defaultValue: "Starting terminal\u2026",
        })}
      />
    );
  }

  // ── Inbox-chat branch ────────────────────────────────────────────
  if (inboxChat) {
    return (
      <InboxChatPanel
        key={inboxChat.id}
        activeInboxChat={inboxChat}
        variant={variant}
      />
    );
  }

  return (
    <ChatThreadLayout
      aria-label={t("aria.chatWorkspace")}
      variant={variant}
      composerHeight={composerHeight}
      imageDragOver={imageDragOver}
      messagesRef={messagesRef}
      footerStack={
        <div className={defaultComposerLaneClassName}>{auxiliaryNode}</div>
      }
      composer={composerNode}
      onDragOver={(event) => {
        event.preventDefault();
        setImageDragOver(true);
      }}
      onDragLeave={() => setImageDragOver(false)}
      onDrop={handleImageDrop}
    >
      {messagesContent}
    </ChatThreadLayout>
  );
}

/**
 * Full-window terminal view rendered when the Terminal channel is
 * active. Keeps every PTY session pane mounted under the hood so
 * tabbing between sessions preserves their buffers/state. Spawning is
 * owned by the sidebar — this component only displays what the
 * orchestrator has already registered, and waits for the live session
 * list to catch up when activeSessionId is set but not yet present.
 */
export function TerminalChannelPanel({
  activeSessionId,
  sessions,
  onClose,
  loadingLabel,
}: {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
  loadingLabel: string;
}) {
  const hasActiveSession = sessions.some(
    (s) => s.sessionId === activeSessionId,
  );

  if (!hasActiveSession) {
    return (
      <div
        data-testid="terminal-channel-loading"
        className="flex flex-1 items-center justify-center text-xs text-muted"
      >
        {loadingLabel}
      </div>
    );
  }

  return (
    <div
      data-testid="terminal-channel-panel"
      className="flex flex-1 min-h-0 min-w-0 flex-col"
    >
      <PtyConsoleBase
        activeSessionId={activeSessionId}
        sessions={sessions}
        onClose={onClose}
        variant="full"
      />
    </div>
  );
}

/**
 * Connector chat panel shown when the messages sidebar has a
 * room selected. Polls `/api/inbox/messages?roomId=...`, renders the
 * transcript through the same ChatTranscript component the dashboard
 * uses, and routes outbound replies back through the runtime's
 * source-specific send handlers.
 */
function InboxChatPanel({
  activeInboxChat,
  variant,
}: {
  activeInboxChat: {
    avatarUrl?: string;
    canSend?: boolean;
    id: string;
    source: string;
    transportSource?: string;
    title: string;
    worldId?: string;
    worldLabel?: string;
  };
  variant: ChatViewVariant;
}) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inboxTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastRenderedMessageKeyRef = useRef<string | null>(null);
  const transportSource =
    activeInboxChat.transportSource ?? activeInboxChat.source;

  const loadInboxMessages = useCallback(async () => {
    try {
      const response = await client.getInboxMessages({
        limit: 200,
        roomId: activeInboxChat.id,
        roomSource: transportSource,
      });
      // Server returns newest first; ChatTranscript expects
      // oldest→newest (conversation layout) so reverse.
      const next = [...response.messages]
        .reverse()
        .map((m): ConversationMessage => m);
      setMessages(next);
      setLoadError(null);
    } catch (err) {
      // A failed poll keeps the last snapshot (next tick retries), but a
      // failure with nothing on screen would otherwise look like an empty
      // inbox — surface it so the user knows the load failed.
      setMessages((prev) => {
        if (prev.length === 0) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
        return prev;
      });
    } finally {
      setLoading(false);
    }
  }, [activeInboxChat.id, transportSource]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadInboxMessages();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInboxMessages]);

  useIntervalWhenDocumentVisible(() => {
    void loadInboxMessages();
  }, 15_000);

  useLayoutEffect(() => {
    if (messages.length === 0) return;

    const el = scrollRef.current;
    if (!el) return;

    const lastMessage = messages[messages.length - 1];
    const nextKey = `${messages.length}:${lastMessage?.id ?? ""}:${
      lastMessage?.timestamp ?? 0
    }`;

    if (lastRenderedMessageKeyRef.current === nextKey) {
      return;
    }

    el.scrollTo({
      top: el.scrollHeight,
      behavior:
        lastRenderedMessageKeyRef.current === null ? "instant" : "smooth",
    });
    lastRenderedMessageKeyRef.current = nextKey;
  }, [messages]);

  const sourceLabel = activeInboxChat.source
    ? activeInboxChat.source.charAt(0).toUpperCase() +
      activeInboxChat.source.slice(1)
    : t("common.channel", { defaultValue: "Channel" });
  const sendAsContext = useMemo(
    () =>
      activeInboxChat.canSend === false
        ? null
        : {
            provider: transportSource,
            connectorId: transportSource,
            source: transportSource,
            channel: activeInboxChat.id,
            channelLabel: activeInboxChat.title,
            writeCapable: true,
          },
    [
      activeInboxChat.canSend,
      activeInboxChat.id,
      activeInboxChat.title,
      transportSource,
    ],
  );
  const connectorSendAs = useConnectorSendAsAccount(sendAsContext, {
    setActionNotice: app?.setActionNotice,
  });
  const {
    accountRequired,
    accountRequiredReason: connectorAccountRequiredReason,
    accounts: sendAsAccounts,
    connectAccount,
    context: normalizedSendAsContext,
    loading: sendAsLoading,
    reconnectAccount,
    saving: sendAsSaving,
    selectAccount,
    selectedAccount: sendAsSelectedAccount,
    sendAsMetadata,
    showPicker: showSendAsPicker,
  } = connectorSendAs;
  const [accountRequiredReason, setAccountRequiredReason] = useState<
    string | null
  >(null);
  const [pendingWriteConfirmationKey, setPendingWriteConfirmationKey] =
    useState<string | null>(null);
  const [confirmedWriteAccountKeys, setConfirmedWriteAccountKeys] = useState<
    Set<string>
  >(() => new Set());

  const currentWriteConfirmationKey = connectorWriteConfirmationKey(
    sendAsContext,
    sendAsSelectedAccount,
  );
  const showWriteConfirmation =
    Boolean(pendingWriteConfirmationKey) &&
    pendingWriteConfirmationKey === currentWriteConfirmationKey;
  const sendAsConnectBusy = normalizedSendAsContext
    ? sendAsSaving.has(
        `add:${normalizedSendAsContext.provider}:${normalizedSendAsContext.connectorId}`,
      )
    : false;
  const blockingAccountReason =
    accountRequiredReason ??
    (accountRequired ? connectorAccountRequiredReason : null);

  const handleSelectSendAsAccount = useCallback(
    (accountId: string) => {
      const account = sendAsAccounts.find((item) => item.id === accountId);
      selectAccount(accountId);
      setAccountRequiredReason(null);
      const key = connectorWriteConfirmationKey(sendAsContext, account);
      if (key && !confirmedWriteAccountKeys.has(key)) {
        setPendingWriteConfirmationKey(key);
      }
    },
    [confirmedWriteAccountKeys, selectAccount, sendAsAccounts, sendAsContext],
  );

  const handleConfirmWriteAccount = useCallback(() => {
    if (!currentWriteConfirmationKey) return;
    setConfirmedWriteAccountKeys((prev) => {
      const next = new Set(prev);
      next.add(currentWriteConfirmationKey);
      return next;
    });
    setPendingWriteConfirmationKey(null);
    setReplyError(null);
  }, [currentWriteConfirmationKey]);

  const handleConnectSendAsAccount = useCallback(() => {
    setAccountRequiredReason(null);
    void connectAccount().catch((error) => {
      setReplyError(
        error instanceof Error ? error.message : "Failed to connect account.",
      );
    });
  }, [connectAccount]);

  const handleReconnectSendAsAccount = useCallback(
    (accountId: string) => {
      setAccountRequiredReason(null);
      void reconnectAccount(accountId).catch((error) => {
        setReplyError(
          error instanceof Error
            ? error.message
            : "Failed to reconnect account.",
        );
      });
    },
    [reconnectAccount],
  );

  const handleReplySend = useCallback(
    async (options?: { force?: boolean }) => {
      const text = replyText.trim();
      if (!text || sending || activeInboxChat.canSend === false) {
        return;
      }
      // `force` is set by the account-required auto-retry after a successful
      // reconnect: the captured `blockingAccountReason` closure is stale (still
      // truthy), but the account is now connected, so bypass the guard.
      if (!options?.force && blockingAccountReason) {
        setReplyError(blockingAccountReason);
        return;
      }
      if (showWriteConfirmation) {
        setReplyError("Confirm the send-as account before sending.");
        return;
      }

      setSending(true);
      setReplyError(null);
      try {
        const response = await client.sendInboxMessage({
          ...(sendAsSelectedAccount?.id
            ? { accountId: sendAsSelectedAccount.id }
            : {}),
          channel: activeInboxChat.id,
          metadata: mergeConnectorSendAsMetadata(undefined, sendAsMetadata),
          roomId: activeInboxChat.id,
          source: transportSource,
          text,
        });

        if (response.message) {
          setMessages((current) => [
            ...current,
            response.message as ConversationMessage,
          ]);
        }

        setReplyText("");
        setAccountRequiredReason(null);
      } catch (error) {
        if (isLikelyAccountRequiredError(error)) {
          setAccountRequiredReason(
            error instanceof Error
              ? error.message
              : "Choose a connector account before sending.",
          );
        }
        setReplyError(
          error instanceof Error
            ? error.message
            : t("inboxview.SendFailed", {
                defaultValue: "Failed to send message.",
              }),
        );
      } finally {
        setSending(false);
      }
    },
    [
      activeInboxChat.canSend,
      activeInboxChat.id,
      blockingAccountReason,
      replyText,
      sendAsMetadata,
      sendAsSelectedAccount,
      sending,
      showWriteConfirmation,
      t,
      transportSource,
    ],
  );

  const handleReplyKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      void handleReplySend();
    },
    [handleReplySend],
  );

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between px-5 py-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-txt truncate">
            {activeInboxChat.title}
          </div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {activeInboxChat.worldLabel
              ? `${activeInboxChat.worldLabel} • `
              : ""}
            {sourceLabel} · {messages.length}{" "}
            {t("inboxview.TotalCountShort", { defaultValue: "messages" })}
          </div>
        </div>
        {activeInboxChat.source ? (
          <ChatSourceIcon source={activeInboxChat.source} className="h-4 w-4" />
        ) : activeInboxChat.avatarUrl ? (
          <img
            src={activeInboxChat.avatarUrl}
            alt={t("inboxview.avatarAlt", {
              defaultValue: "{{title}} avatar",
              title: activeInboxChat.title,
            })}
            className="h-8 w-8 shrink-0 rounded-full border border-border/35 object-cover "
          />
        ) : null}
      </div>
      <div
        ref={scrollRef}
        data-testid="inbox-chat-scroll"
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4"
      >
        {loading && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            {t("inboxview.Loading", { defaultValue: "Loading messages…" })}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-muted">
            {loadError
              ? t("inboxview.LoadFailed", {
                  message: loadError,
                  defaultValue: "Couldn't load messages: {{message}}",
                })
              : t("inboxview.EmptyRoom", {
                  defaultValue: "No messages in this chat yet.",
                })}
          </div>
        ) : (
          <ChatTranscript
            variant={variant}
            messages={messages}
            userMessagesOnRight={false}
            renderMessageContent={(message) => (
              <MessageContent message={message as ConversationMessage} />
            )}
          />
        )}
      </div>
      {activeInboxChat.canSend === false ? (
        <div className="bg-bg-hover/40 px-5 py-3 text-xs-tight leading-5 text-muted">
          {t("inboxview.ReadOnlyReplyHint", {
            defaultValue:
              "This {{source}} chat is readable, but outbound replies are not available for this connector yet.",
            source: sourceLabel,
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <ConnectorAccountPicker
            accounts={sendAsAccounts}
            connectBusy={sendAsConnectBusy}
            loading={sendAsLoading}
            selectedAccount={sendAsSelectedAccount}
            sourceLabel={sourceLabel}
            show={showSendAsPicker}
            onConnectAccount={handleConnectSendAsAccount}
            onReconnectAccount={handleReconnectSendAsAccount}
            onSelectAccount={handleSelectSendAsAccount}
          />
          {blockingAccountReason ? (
            <AccountRequiredCard
              accounts={sendAsAccounts}
              connectBusy={sendAsConnectBusy}
              description={blockingAccountReason}
              loading={sendAsLoading}
              selectedAccount={sendAsSelectedAccount}
              sourceLabel={sourceLabel}
              onConnectAccount={handleConnectSendAsAccount}
              onReconnectAccount={handleReconnectSendAsAccount}
              onSelectAccount={handleSelectSendAsAccount}
              retryAction={async () => {
                await handleReplySend({ force: true });
              }}
            />
          ) : showWriteConfirmation ? (
            <AccountRequiredCard
              accounts={sendAsAccounts}
              connectBusy={sendAsConnectBusy}
              confirmLabel="Confirm send-as"
              description={`First send with ${sendAsSelectedAccount ? connectorAccountDisplayName(sendAsSelectedAccount) : "this account"} in ${sourceLabel}. Confirm before Eliza writes through it.`}
              loading={sendAsLoading}
              selectedAccount={sendAsSelectedAccount}
              sourceLabel={sourceLabel}
              title="Confirm send-as account"
              onConfirm={handleConfirmWriteAccount}
              onConnectAccount={handleConnectSendAsAccount}
              onReconnectAccount={handleReconnectSendAsAccount}
              onSelectAccount={handleSelectSendAsAccount}
            />
          ) : null}
          <div className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-2xs leading-snug text-warn">
            {t("inboxview.AgentSendWarning", {
              defaultValue:
                "This message will be sent as your agent in {{source}}.",
              source: sourceLabel,
            })}
          </div>
          <ChatComposerShell variant="default">
            <ChatComposer
              variant="default"
              textareaRef={inboxTextareaRef}
              chatInput={replyText}
              chatPendingImagesCount={0}
              isComposerLocked={sending}
              isAgentStarting={false}
              chatSending={sending}
              voice={inertVoiceState}
              agentVoiceEnabled={false}
              showAgentVoiceToggle={false}
              t={t}
              hideAttachButton
              placeholder={t("inboxview.ReplyPlaceholder", {
                defaultValue: "Reply in {{source}}",
                source: sourceLabel,
              })}
              onAttachImage={() => {}}
              onChatInputChange={setReplyText}
              onKeyDown={handleReplyKeyDown}
              onSend={() => void handleReplySend()}
              onStop={() => {}}
              onStopSpeaking={() => {}}
              onToggleAgentVoice={() => {}}
            />
          </ChatComposerShell>
          {replyError ? (
            <div className="px-1 text-xs-tight text-danger">{replyError}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const inertVoiceState = {
  assistantTtsQuality: undefined,
  captureMode: "idle" as const,
  interimTranscript: "",
  isListening: false,
  isSpeaking: false,
  startListening: () => {},
  stopListening: () => {},
  supported: false,
  toggleListening: () => {},
};
