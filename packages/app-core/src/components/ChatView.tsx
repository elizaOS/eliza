/**
 * Chat view component.
 *
 * Layout: flex column filling parent. Header row (title + clear + toggles).
 * Scrollable messages area. Share/file notices below messages.
 * Input row at bottom with mic + textarea + send button.
 */

import {
  type ConversationChannelType,
  type ConversationMessage,
  client,
  type ImageAttachment,
  type VoiceConfig,
} from "@elizaos/app-core/api";
import { isRoutineCodingAgentMessage } from "@elizaos/app-core/chat";
import { VOICE_CONFIG_UPDATED_EVENT } from "@elizaos/app-core/events";
import {
  useChatAvatarVoiceBridge,
  useTimeout,
  useVoiceChat,
  type VoiceCaptureMode,
  type VoicePlaybackStartEvent,
} from "@elizaos/app-core/hooks";
import { getVrmPreviewUrl, useApp } from "@elizaos/app-core/state";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentActivityBox } from "./AgentActivityBox";
import { ChatComposer } from "./ChatComposer";
import { ChatEmptyState, ChatMessage, TypingIndicator } from "./ChatMessage";
import { MessageContent } from "./MessageContent";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const CHAT_INPUT_MIN_HEIGHT_PX = 46;
const CHAT_INPUT_MAX_HEIGHT_PX = 200;
const COMPANION_VISIBLE_MESSAGE_LIMIT = 2;
const COMPANION_HISTORY_HOLD_MS = 30_000;
const COMPANION_HISTORY_FADE_MS = 5_000;
const COMPANION_MESSAGE_LAYER_TOP = "calc(-100% + 1.5rem)";
const COMPANION_MESSAGE_LAYER_BOTTOM = "4rem";
const COMPANION_MESSAGE_LAYER_MASK =
  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 6%, rgba(0,0,0,0.82) 12%, black 17%, black 100%)";

type ChatViewVariant = "default" | "game-modal";

interface ChatViewProps {
  variant?: ChatViewVariant;
}

interface CompanionCarryoverState {
  expiresAtMs: number;
  fadeStartsAtMs: number;
  messages: ConversationMessage[];
}

function findLatestAssistantMessage(messages: ConversationMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim());
}

function useChatVoiceController(options: {
  agentVoiceMuted: boolean;
  chatFirstTokenReceived: boolean;
  chatInput: string;
  chatSending: boolean;
  conversationMessages: ConversationMessage[];
  elizaCloudConnected: boolean;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  handleChatSend: (channelType?: ConversationChannelType) => Promise<void>;
  isComposerLocked: boolean;
  isGameModal: boolean;
  setState: ReturnType<typeof useApp>["setState"];
  uiLanguage: string;
}) {
  const { setTimeout } = useTimeout();
  const {
    agentVoiceMuted,
    chatFirstTokenReceived,
    chatInput,
    chatSending,
    conversationMessages,
    elizaCloudConnected,
    handleChatEdit,
    handleChatSend,
    isComposerLocked,
    isGameModal,
    setState,
    uiLanguage,
  } = options;
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [voiceLatency, setVoiceLatency] = useState<{
    firstSegmentCached: boolean | null;
    speechEndToFirstTokenMs: number | null;
    speechEndToVoiceStartMs: number | null;
  } | null>(null);
  const pendingVoiceTurnRef = useRef<{
    expiresAtMs: number;
    firstSegmentCached?: boolean;
    firstTokenAtMs?: number;
    speechEndedAtMs: number;
    voiceStartedAtMs?: number;
  } | null>(null);
  const suppressedAssistantSpeechIdRef = useRef<string | null>(null);
  const voiceDraftBaseInputRef = useRef("");
  const prevIsGameModalRef = useRef(isGameModal);
  const gameModalJustActivatedRef = useRef(false);

  const loadVoiceConfig = useCallback(async () => {
    try {
      const cfg = await client.getConfig();
      const messages = cfg.messages as
        | Record<string, Record<string, string>>
        | undefined;
      const tts = messages?.tts as VoiceConfig | undefined;
      setVoiceConfig(tts ?? null);
    } catch {
      /* ignore — will use browser TTS fallback */
    }
  }, []);

  useEffect(() => {
    void loadVoiceConfig();
  }, [loadVoiceConfig]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<VoiceConfig | undefined>).detail;
      if (detail && typeof detail === "object") {
        setVoiceConfig(detail);
        return;
      }
      void loadVoiceConfig();
    };

    window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
    return () =>
      window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
  }, [loadVoiceConfig]);

  const composeVoiceDraft = useCallback((transcript: string) => {
    const base = voiceDraftBaseInputRef.current.trim();
    const spoken = transcript.trim();
    if (base && spoken) {
      return `${base} ${spoken}`;
    }
    return base || spoken;
  }, []);

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (isComposerLocked) return;
      const composedText = composeVoiceDraft(text);
      if (!composedText) return;
      const speechEndedAtMs = nowMs();
      pendingVoiceTurnRef.current = {
        expiresAtMs: speechEndedAtMs + 15000,
        speechEndedAtMs,
      };
      setVoiceLatency(null);
      setState("chatInput", composedText);
      setTimeout(() => void handleChatSend("VOICE_DM"), 50);
    },
    [composeVoiceDraft, handleChatSend, isComposerLocked, setState, setTimeout],
  );

  const handleVoiceTranscriptPreview = useCallback(
    (text: string) => {
      if (isComposerLocked) return;
      setState("chatInput", composeVoiceDraft(text));
    },
    [composeVoiceDraft, isComposerLocked, setState],
  );

  const handleVoicePlaybackStart = useCallback(
    (event: VoicePlaybackStartEvent) => {
      const pending = pendingVoiceTurnRef.current;
      if (!pending) return;
      if (event.startedAtMs > pending.expiresAtMs) {
        pendingVoiceTurnRef.current = null;
        return;
      }
      if (pending.voiceStartedAtMs != null) return;

      pending.voiceStartedAtMs = event.startedAtMs;
      pending.firstSegmentCached = event.cached;

      setVoiceLatency((prev) => ({
        firstSegmentCached: event.cached,
        speechEndToFirstTokenMs: prev?.speechEndToFirstTokenMs ?? null,
        speechEndToVoiceStartMs: Math.max(
          0,
          Math.round(event.startedAtMs - pending.speechEndedAtMs),
        ),
      }));
    },
    [],
  );

  const voice = useVoiceChat({
    cloudConnected: elizaCloudConnected,
    interruptOnSpeech: isGameModal,
    lang: uiLanguage === "zh-CN" ? "zh-CN" : "en-US",
    onPlaybackStart: handleVoicePlaybackStart,
    onTranscript: handleVoiceTranscript,
    onTranscriptPreview: handleVoiceTranscriptPreview,
    voiceConfig,
  });
  const {
    queueAssistantSpeech,
    speak,
    startListening,
    stopListening,
    stopSpeaking,
  } = voice;

  const beginVoiceCapture = useCallback(
    (mode: Exclude<VoiceCaptureMode, "idle"> = "compose") => {
      if (isComposerLocked || voice.isListening) return;
      const latestAssistant = findLatestAssistantMessage(conversationMessages);
      suppressedAssistantSpeechIdRef.current = latestAssistant?.id ?? null;
      voiceDraftBaseInputRef.current = chatInput;
      stopSpeaking();
      void startListening(mode);
    },
    [
      chatInput,
      conversationMessages,
      isComposerLocked,
      startListening,
      stopSpeaking,
      voice.isListening,
    ],
  );

  const endVoiceCapture = useCallback(
    (captureOptions?: { submit?: boolean }) => {
      if (!voice.isListening) return;
      void stopListening(captureOptions);
    },
    [stopListening, voice.isListening],
  );

  const handleSpeakMessage = useCallback(
    (messageId: string, text: string) => {
      if (!text.trim()) return;
      suppressedAssistantSpeechIdRef.current = messageId;
      speak(text);
    },
    [speak],
  );

  const handleEditMessage = useCallback(
    async (messageId: string, text: string) => {
      stopSpeaking();
      return handleChatEdit(messageId, text);
    },
    [handleChatEdit, stopSpeaking],
  );

  // Track when isGameModal transitions from false→true so we can suppress
  // the stale "latest assistant message" speech that would otherwise replay.
  useEffect(() => {
    if (isGameModal && !prevIsGameModalRef.current) {
      gameModalJustActivatedRef.current = true;
    }
    prevIsGameModalRef.current = isGameModal;
  }, [isGameModal]);

  useEffect(() => {
    if (!isGameModal || agentVoiceMuted || voice.isListening) return;
    // Skip the stale replay when the view just became active (mode switch).
    if (gameModalJustActivatedRef.current) {
      gameModalJustActivatedRef.current = false;
      return;
    }
    const latestAssistant = findLatestAssistantMessage(conversationMessages);
    if (!latestAssistant) return;
    if (suppressedAssistantSpeechIdRef.current === latestAssistant.id) return;

    queueAssistantSpeech(
      latestAssistant.id,
      latestAssistant.text,
      !chatSending,
    );
    suppressedAssistantSpeechIdRef.current = null;
  }, [
    agentVoiceMuted,
    chatSending,
    conversationMessages,
    isGameModal,
    queueAssistantSpeech,
    voice.isListening,
  ]);

  useEffect(() => {
    if (!agentVoiceMuted) return;
    stopSpeaking();
  }, [agentVoiceMuted, stopSpeaking]);

  useEffect(() => {
    const pending = pendingVoiceTurnRef.current;
    if (!pending || !chatFirstTokenReceived) return;
    if (nowMs() > pending.expiresAtMs) {
      pendingVoiceTurnRef.current = null;
      return;
    }
    if (pending.firstTokenAtMs != null) return;

    const firstTokenAtMs = nowMs();
    pending.firstTokenAtMs = firstTokenAtMs;
    setVoiceLatency((prev) => ({
      firstSegmentCached: prev?.firstSegmentCached ?? null,
      speechEndToFirstTokenMs: Math.max(
        0,
        Math.round(firstTokenAtMs - pending.speechEndedAtMs),
      ),
      speechEndToVoiceStartMs: prev?.speechEndToVoiceStartMs ?? null,
    }));
  }, [chatFirstTokenReceived]);

  return {
    beginVoiceCapture,
    endVoiceCapture,
    handleEditMessage,
    handleSpeakMessage,
    stopSpeaking,
    voice,
    voiceLatency,
  };
}

function useGameModalMessages(options: {
  activeConversationId: string | null;
  agentVoiceMuted: boolean;
  companionMessageCutoffTs: number;
  isGameModal: boolean;
  setState: ReturnType<typeof useApp>["setState"];
  stopSpeaking: () => void;
  visibleMsgs: ConversationMessage[];
}) {
  const {
    activeConversationId,
    agentVoiceMuted,
    companionMessageCutoffTs,
    isGameModal,
    setState,
    stopSpeaking,
    visibleMsgs,
  } = options;
  const previousCompanionCutoffTsRef = useRef(companionMessageCutoffTs);
  const previousGameModalVisibleMsgsRef = useRef<ConversationMessage[]>([]);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const companionVoiceInitializedRef = useRef(false);
  const [companionNowMs, setCompanionNowMs] = useState(() => Date.now());
  const [companionCarryover, setCompanionCarryover] =
    useState<CompanionCarryoverState | null>(null);

  const gameModalRecentMsgs = useMemo(
    () =>
      visibleMsgs.filter(
        (message) => message.timestamp >= companionMessageCutoffTs,
      ),
    [companionMessageCutoffTs, visibleMsgs],
  );
  const gameModalContextMsgs = useMemo(() => {
    if (gameModalRecentMsgs.length > 0) {
      return gameModalRecentMsgs;
    }
    return visibleMsgs.slice(-COMPANION_VISIBLE_MESSAGE_LIMIT);
  }, [gameModalRecentMsgs, visibleMsgs]);
  const gameModalVisibleMsgs = useMemo(
    () => gameModalContextMsgs.slice(-COMPANION_VISIBLE_MESSAGE_LIMIT),
    [gameModalContextMsgs],
  );
  const gameModalCarryoverOpacity = useMemo(() => {
    if (!companionCarryover) return 0;
    if (companionNowMs < companionCarryover.fadeStartsAtMs) return 1;
    const remainingMs = companionCarryover.expiresAtMs - companionNowMs;
    if (remainingMs <= 0) return 0;
    return Math.max(0, remainingMs / COMPANION_HISTORY_FADE_MS);
  }, [companionCarryover, companionNowMs]);

  useEffect(() => {
    if (!isGameModal) {
      previousActiveConversationIdRef.current = activeConversationId;
      companionVoiceInitializedRef.current = false;
      return;
    }
    if (companionVoiceInitializedRef.current) return;
    companionVoiceInitializedRef.current = true;
    if (agentVoiceMuted) {
      setState("chatAgentVoiceMuted", false);
    }
  }, [activeConversationId, agentVoiceMuted, isGameModal, setState]);

  useEffect(() => {
    if (!isGameModal) {
      previousActiveConversationIdRef.current = activeConversationId;
      return;
    }

    if (previousActiveConversationIdRef.current === activeConversationId) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    previousGameModalVisibleMsgsRef.current = [];
    previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
    setCompanionCarryover(null);
    stopSpeaking();
  }, [
    activeConversationId,
    companionMessageCutoffTs,
    isGameModal,
    stopSpeaking,
  ]);

  useEffect(() => {
    if (!isGameModal) {
      previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
      return;
    }

    const previousCutoffTs = previousCompanionCutoffTsRef.current;
    if (companionMessageCutoffTs > previousCutoffTs) {
      const carryoverMessages = previousGameModalVisibleMsgsRef.current.filter(
        (message) => message.timestamp < companionMessageCutoffTs,
      );
      if (carryoverMessages.length > 0) {
        const startedAtMs = Date.now();
        setCompanionCarryover({
          expiresAtMs:
            startedAtMs + COMPANION_HISTORY_HOLD_MS + COMPANION_HISTORY_FADE_MS,
          fadeStartsAtMs: startedAtMs + COMPANION_HISTORY_HOLD_MS,
          messages: carryoverMessages,
        });
      } else {
        setCompanionCarryover(null);
      }
    }
    previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
  }, [companionMessageCutoffTs, isGameModal]);

  useEffect(() => {
    previousGameModalVisibleMsgsRef.current = gameModalVisibleMsgs;
  }, [gameModalVisibleMsgs]);

  useEffect(() => {
    if (!companionCarryover) return;

    const tick = () => setCompanionNowMs(Date.now());
    tick();

    const intervalId = window.setInterval(tick, 250);
    return () => window.clearInterval(intervalId);
  }, [companionCarryover]);

  useEffect(() => {
    if (!companionCarryover) return;
    if (companionNowMs >= companionCarryover.expiresAtMs) {
      setCompanionCarryover(null);
    }
  }, [companionCarryover, companionNowMs]);

  return {
    companionCarryover,
    gameModalCarryoverOpacity,
    gameModalVisibleMsgs,
  };
}

export function ChatView({ variant = "default" }: ChatViewProps) {
  const isGameModal = variant === "game-modal";
  const showComposerVoiceToggle = false;
  const {
    agentStatus,
    activeConversationId,
    chatInput,
    chatSending,
    chatFirstTokenReceived,
    companionMessageCutoffTs,
    conversationMessages,
    handleChatSend,
    handleChatStop,
    handleChatEdit,
    elizaCloudConnected,
    setState,
    droppedFiles,
    shareIngestNotice,
    chatAgentVoiceMuted: agentVoiceMuted,
    selectedVrmIndex,
    chatPendingImages,
    setChatPendingImages,
    uiLanguage,
    ptySessions,
    t,
  } = useApp();

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageDragOver, setImageDragOver] = useState(false);

  // ── Derived composer state ──────────────────────────────────────
  const isAgentStarting =
    agentStatus?.state === "starting" || agentStatus?.state === "restarting";
  const isComposerLocked = chatSending || isAgentStarting;
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
    conversationMessages,
    elizaCloudConnected,
    handleChatEdit,
    handleChatSend,
    isComposerLocked,
    isGameModal,
    setState,
    uiLanguage,
  });
  const handleChatAvatarSpeakingChange = useCallback(
    (isSpeaking: boolean) => {
      setState("chatAvatarSpeaking", isSpeaking);
    },
    [setState],
  );

  const agentName = agentStatus?.agentName ?? "Agent";
  const msgs = conversationMessages;
  const visibleMsgs = useMemo(
    () =>
      msgs.filter(
        (msg) =>
          !(
            chatSending &&
            !chatFirstTokenReceived &&
            msg.role === "assistant" &&
            !msg.text.trim()
          ) && !isRoutineCodingAgentMessage(msg),
      ),
    [chatFirstTokenReceived, chatSending, msgs],
  );
  const {
    companionCarryover,
    gameModalCarryoverOpacity,
    gameModalVisibleMsgs,
  } = useGameModalMessages({
    activeConversationId,
    agentVoiceMuted: agentVoiceMuted,
    companionMessageCutoffTs,
    isGameModal,
    setState,
    stopSpeaking,
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
    if (isGameModal) {
      return;
    }
    if (!chatSending && visibleMsgs.length === 0) {
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
  }, [chatSending, isGameModal, visibleMsgs]);

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
          new Promise<ImageAttachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>" — strip the prefix
              const commaIdx = result.indexOf(",");
              const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
              resolve({ data, mimeType: file.type, name: file.name });
            };
            reader.readAsDataURL(file);
          }),
      );

      void Promise.all(readers).then((attachments) => {
        setChatPendingImages((prev) => {
          const combined = [...prev, ...attachments];
          // Mirror the server-side MAX_CHAT_IMAGES=4 limit so the user gets
          // immediate feedback rather than a 400 after upload.
          return combined.slice(0, 4);
        });
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

  return (
    <section
      aria-label="Chat workspace"
      className={`flex flex-col flex-1 min-h-0 relative${isGameModal ? " overflow-visible px-2 sm:px-3" : ""}${imageDragOver ? " ring-2 ring-accent ring-inset" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setImageDragOver(true);
      }}
      onDragLeave={() => setImageDragOver(false)}
      onDrop={handleImageDrop}
    >
      {/* ── Messages ───────────────────────────────────────────────── */}
      <div
        ref={messagesRef}
        data-testid="chat-messages-scroll"
        className={
          isGameModal
            ? "absolute inset-x-0 overflow-hidden select-none pointer-events-none"
            : "chat-native-scrollbar relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto py-2"
        }
        style={
          isGameModal
            ? {
                zIndex: 1,
                top: COMPANION_MESSAGE_LAYER_TOP,
                bottom: COMPANION_MESSAGE_LAYER_BOTTOM,
                userSelect: "none",
                WebkitUserSelect: "none",
                maskImage: COMPANION_MESSAGE_LAYER_MASK,
                WebkitMaskImage: COMPANION_MESSAGE_LAYER_MASK,
              }
            : {
                zIndex: 1,
              }
        }
      >
        {visibleMsgs.length === 0 && !chatSending ? (
          isGameModal ? (
            <div className="flex h-full items-end px-1 py-4" />
          ) : (
            <ChatEmptyState agentName={agentName} />
          )
        ) : isGameModal ? (
          <div className="flex h-full w-full flex-col justify-end gap-4 px-1 py-4">
            {companionCarryover?.messages.map((msg) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={`carryover-${msg.id}`}
                  data-testid="companion-message-row"
                  data-companion-carryover="true"
                  className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
                  style={{ opacity: gameModalCarryoverOpacity }}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                      isUser
                        ? "bg-accent/85 text-white rounded-br-sm"
                        : "border border-white/10 bg-black/45 text-white/95 rounded-bl-sm backdrop-blur-md"
                    }`}
                  >
                    <div
                      className="break-words"
                      style={{ fontFamily: "var(--font-chat)" }}
                    >
                      <MessageContent message={msg} />
                    </div>
                  </div>
                </div>
              );
            })}
            {gameModalVisibleMsgs.map((msg) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={msg.id}
                  data-testid="companion-message-row"
                  className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                      isUser
                        ? "bg-accent/85 text-white rounded-br-sm"
                        : "border border-white/10 bg-black/45 text-white/95 rounded-bl-sm backdrop-blur-md"
                    }`}
                  >
                    <div
                      className="break-words"
                      style={{ fontFamily: "var(--font-chat)" }}
                    >
                      <MessageContent message={msg} />
                    </div>
                  </div>
                </div>
              );
            })}
            {chatSending && !chatFirstTokenReceived && (
              <div className="flex w-full justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-3 bg-black/30 flex items-center gap-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full pl-2 sm:pl-3 pr-3 sm:pr-4 space-y-1">
            {visibleMsgs.map((msg, i) => {
              const prev = i > 0 ? visibleMsgs[i - 1] : null;
              const isGrouped = prev?.role === msg.role;

              return (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isGrouped={isGrouped}
                  agentName={agentName}
                  agentAvatarSrc={agentAvatarSrc}
                  onSpeak={handleSpeakMessage}
                  onEdit={handleEditMessage}
                />
              );
            })}

            {chatSending && !chatFirstTokenReceived && (
              <TypingIndicator
                agentName={agentName}
                agentAvatarSrc={agentAvatarSrc}
              />
            )}
          </div>
        )}
      </div>

      {/* Agent activity box — sticky status per active coding-agent task */}
      <AgentActivityBox sessions={ptySessions} />

      {/* Share ingest notice */}
      {shareIngestNotice && (
        <div className="text-xs text-ok py-1 relative" style={{ zIndex: 1 }}>
          {shareIngestNotice}
        </div>
      )}

      {/* Dropped files */}
      {droppedFiles.length > 0 && (
        <div
          className="text-xs text-muted py-0.5 flex gap-2 relative"
          style={{ zIndex: 1 }}
        >
          {droppedFiles.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}

      {/* Pending image thumbnails */}
      {chatPendingImages.length > 0 && (
        <div
          className="flex gap-2 flex-wrap py-1 relative"
          data-no-camera-drag={isGameModal || undefined}
          style={{ zIndex: 1 }}
        >
          {chatPendingImages.map((img, imgIdx) => (
            <div
              key={`${img.name}-${img.data}`}
              className="relative group w-16 h-16 shrink-0"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name}
                className="w-16 h-16 object-cover border border-border rounded"
              />
              <button
                type="button"
                title={t("chatview.RemoveImage")}
                aria-label={`Remove image ${img.name}`}
                onClick={() => removeImage(imgIdx)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-danger text-white text-[10px] flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {voiceLatency && (
        <div
          className="pb-1 text-[10px] text-muted relative"
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
      )}

      {/* ── Input row: mic + paperclip + textarea + send ───────────── */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      {isGameModal ? (
        /* ── Game-modal composer ──────────────────────────────────────── */
        <div
          className="mt-auto pt-2.5 relative"
          data-no-camera-drag="true"
          style={{ zIndex: 1 }}
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
          />
        </div>
      ) : (
        /* ── Default composer ─────────────────────────────────────────── */
        <div
          className="border-t border-border pt-3 pb-3 sm:pb-4 px-2 sm:px-3 relative"
          style={{ zIndex: 1 }}
        >
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
          />
        </div>
      )}
    </section>
  );
}
