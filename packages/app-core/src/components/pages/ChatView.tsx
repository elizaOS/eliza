import {
  CodingAgentControlChip,
  PtyConsoleDrawer,
} from "@elizaos/app-task-coordinator";
import {
  ChatAttachmentStrip,
  ChatComposer,
  ChatComposerShell,
  ChatSourceIcon,
  ChatThreadLayout,
  ChatTranscript,
  TypingIndicator,
} from "@elizaos/ui";
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
import { client } from "../../api/client";
import type {
  ConversationMessage,
  ImageAttachment,
} from "../../api/client-types-chat";
import { isRoutineCodingAgentMessage } from "../../chat";
import { useChatAvatarVoiceBridge } from "../../hooks/useChatAvatarVoiceBridge";
import { useChatComposer } from "../../state/ChatComposerContext";
import { usePtySessions } from "../../state/PtySessionsContext";
import { useApp } from "../../state/useApp";
import { getVrmPreviewUrl } from "../../state/vrm";
import { AgentActivityBox } from "../chat/AgentActivityBox";
import { MessageContent } from "../chat/MessageContent";
import {
  useChatVoiceController,
  useGameModalMessages,
} from "./chat-view-hooks";

export { __resetCompanionSpeechMemoryForTests } from "./chat-view-hooks";

const CHAT_INPUT_MIN_HEIGHT_PX = 46;
const CHAT_INPUT_MAX_HEIGHT_PX = 200;
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
  /** Hide the always-visible terminal/PTY panel (used in embedded overlays). */
  hideTerminalPanel?: boolean;
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
  hideTerminalPanel = false,
}: ChatViewProps) {
  const app = useApp();
  const isGameModal = variant === "game-modal";
  const showComposerVoiceToggle = false;
  const {
    agentStatus,
    activeConversationId,
    activeInboxChat,
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
  const [ptyDrawerSessionId, setPtyDrawerSessionId] = useState<string | null>(
    null,
  );

  // Auto-expand terminal when a session hits error or blocked status
  useEffect(() => {
    const problemSession = ptySessions.find(
      (s) => s.status === "error" || s.status === "blocked",
    );
    if (problemSession && ptyDrawerSessionId !== problemSession.sessionId) {
      setPtyDrawerSessionId(problemSession.sessionId);
    }
  }, [ptySessions, ptyDrawerSessionId]);

  // ── Coding agent preflight ──────────────────────────────────────
  const [codingAgentsAvailable, setCodingAgentsAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/coding-agents/preflight", { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { installed?: unknown[]; available?: boolean }) => {
        setCodingAgentsAvailable(
          (Array.isArray(data.installed) && data.installed.length > 0) ||
            data.available === true,
        );
      })
      .catch(() => {
        /* preflight unavailable or aborted — hide code button */
      });
    return () => controller.abort();
  }, []);

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
  const hasCompletedLifecycleActivity =
    !chatSending &&
    conversationMessages.some(
      (message) =>
        message.role === "user" ||
        (message.role === "assistant" && message.text.trim().length > 0),
    );
  const isComposerLocked = isAgentStarting && !hasCompletedLifecycleActivity;
  const {
    beginVoiceCapture,
    endVoiceCapture,
    handleEditMessage,
    handleSpeakMessage,
    stopSpeaking,
    voice,
    voiceLatency,
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

  const agentName = characterData?.name || agentStatus?.agentName || "Agent";
  const msgs = conversationMessages;
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
    usingAudioAnalysis: voice.usingAudioAnalysis,
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
  }, [chatInput]);

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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerLocked) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleChatSend();
    }
  };

  const addImageFiles = useCallback(
    (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!imageFiles.length) return;

      const readers = imageFiles.map(
        (file) =>
          new Promise<ImageAttachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>" — strip the prefix
              const commaIdx = result.indexOf(",");
              const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
              resolve({ data, mimeType: file.type, name: file.name });
            };
            reader.onerror = () =>
              reject(reader.error ?? new Error("Failed to read file"));
            reader.onabort = () => reject(new Error("File read aborted"));
            reader.readAsDataURL(file);
          }),
      );

      void Promise.all(readers)
        .then((attachments) => {
          setChatPendingImages((prev) => {
            const combined = [...prev, ...attachments];
            // Mirror the server-side MAX_CHAT_IMAGES=4 limit so the user gets
            // immediate feedback rather than a 400 after upload.
            return combined.slice(0, 4);
          });
        })
        .catch((err) => {
          console.warn("Failed to load image attachments:", err);
        });
    },
    [setChatPendingImages],
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
    saving: t("chatmessage.Saving", {
      defaultValue: "Saving...",
    }),
  };

  const messagesContent =
    visibleMsgs.length === 0 && !chatSending ? null : (
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
          <MessageContent message={message as ConversationMessage} />
        )}
        typingIndicator={
          chatSending && !chatFirstTokenReceived ? (
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

  const handleNewShellSession = useCallback(async () => {
    try {
      const { sessionId } = await client.spawnShellSession();
      setPtyDrawerSessionId(sessionId);
    } catch (err) {
      console.error("[ChatView] Failed to spawn shell session:", err);
    }
  }, []);

  const drawerProps = {
    activeSessionId: ptyDrawerSessionId,
    sessions: ptySessions,
    onSessionClick: (id: string) =>
      setPtyDrawerSessionId((prev) => (prev === id ? null : id)),
    onNewSession: handleNewShellSession,
    onClose: () => setPtyDrawerSessionId(null),
  };

  const terminalPanelNode = isGameModal ? (
    <div className="pointer-events-auto">
      <PtyConsoleDrawer {...drawerProps} />
    </div>
  ) : (
    <PtyConsoleDrawer {...drawerProps} />
  );

  const auxiliaryNode = (
    <>
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
        removeLabel={(item) => `Remove image ${item.name}`}
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
              ? "cached"
              : "uncached"}
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

  const composerNode = isGameModal ? (
    <ChatComposerShell
      variant="game-modal"
      shellRef={composerRef}
      before={
        <>
          <CodingAgentControlChip />
          <AgentActivityBox
            sessions={ptySessions}
            onSessionClick={
              onPtySessionClick ??
              ((id) =>
                setPtyDrawerSessionId((prev) => (prev === id ? null : id)))
            }
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
    <ChatComposerShell variant="default" before={<CodingAgentControlChip />}>
      <ChatComposer
        variant="default"
        textareaRef={textareaRef}
        chatInput={chatInput}
        chatPendingImagesCount={chatPendingImages.length}
        isComposerLocked={isComposerLocked}
        isAgentStarting={isAgentStarting}
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
        <>
          {auxiliaryNode}
          {hideTerminalPanel ? null : terminalPanelNode}
        </>
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
 * Connector chat panel shown when the unified messages sidebar has a
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
  const t = app?.t ?? ((key: string) => key);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastRenderedMessageKeyRef = useRef<string | null>(null);
  const transportSource =
    activeInboxChat.transportSource ?? activeInboxChat.source;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await client.getInboxMessages({
          limit: 200,
          roomId: activeInboxChat.id,
          roomSource: transportSource,
        });
        if (cancelled) return;
        // Server returns newest first; ChatTranscript expects
        // oldest→newest (conversation layout) so reverse.
        const next = [...response.messages]
          .reverse()
          .map((m): ConversationMessage => m);
        setMessages(next);
      } catch {
        // Transient errors keep the last snapshot; next poll retries.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeInboxChat.id, transportSource]);

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
    : "Channel";

  const handleReplySend = useCallback(async () => {
    const text = replyText.trim();
    if (!text || sending || activeInboxChat.canSend === false) {
      return;
    }

    setSending(true);
    setReplyError(null);
    try {
      const response = await client.sendInboxMessage({
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
    } catch (error) {
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
  }, [
    activeInboxChat.canSend,
    activeInboxChat.id,
    replyText,
    sending,
    t,
    transportSource,
  ]);

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
            alt={`${activeInboxChat.title} avatar`}
            className="h-8 w-8 shrink-0 rounded-full border border-border/35 object-cover shadow-[0_10px_18px_-16px_rgba(15,23,42,0.45)]"
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
            {t("inboxview.EmptyRoom", {
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
      <div className="bg-bg-hover/40 px-5 py-3">
        {activeInboxChat.canSend === false ? (
          <div className="text-xs-tight leading-5 text-muted">
            {t("inboxview.ReadOnlyReplyHint", {
              defaultValue:
                "This {{source}} chat is readable, but outbound replies are not available for this connector yet.",
              source: sourceLabel,
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
              onKeyDown={handleReplyKeyDown}
              placeholder={t("inboxview.ReplyPlaceholder", {
                defaultValue: "Reply in {{source}}",
                source: sourceLabel,
              })}
              disabled={sending}
              rows={2}
              className="min-h-[72px] w-full resize-y rounded-xl border border-border/50 bg-bg px-3 py-2 text-sm text-txt outline-none transition focus:border-accent/55"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs-tight text-muted">
                {replyError
                  ? replyError
                  : t("inboxview.ReplyHint", {
                      defaultValue:
                        "Sent through the connected {{source}} account on this device.",
                      source: sourceLabel,
                    })}
              </div>
              <button
                type="button"
                onClick={() => void handleReplySend()}
                disabled={sending || replyText.trim().length === 0}
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending
                  ? t("inboxview.Sending", { defaultValue: "Sending…" })
                  : t("inboxview.Send", { defaultValue: "Send" })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
