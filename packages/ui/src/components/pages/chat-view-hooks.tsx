import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { useTimeout } from "../../hooks/useTimeout";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  ConversationChannelType,
  ConversationMessage,
} from "../../api/client-types-chat";
import type { VoiceConfig } from "../../api/client-types-config";
import type { ElizaCloudStatusUpdatedDetail } from "../../events";
import {
  ELIZA_CLOUD_STATUS_UPDATED_EVENT,
  VOICE_CONFIG_UPDATED_EVENT,
} from "../../events";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import type { useApp } from "../../state/useApp";
import { ttsDebug } from "../../utils/tts-debug";
import { resolveCharacterVoiceConfigFromAppConfig } from "../../voice/character-voice-config";
import type {
  VoiceAssistantSpeechTelemetry,
  VoiceCaptureMode,
  VoicePlaybackStartEvent,
  VoiceTranscriptEvent,
} from "../../voice/voice-chat-types";
import { useCompanionSceneStatus } from "../companion/injected";

/* ── Shared constants ──────────────────────────────────────────────── */

const COMPANION_VISIBLE_MESSAGE_LIMIT = 2;
const COMPANION_HISTORY_HOLD_MS = 30_000;
const COMPANION_HISTORY_FADE_MS = 5_000;

/* ── Helpers ───────────────────────────────────────────────────────── */

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function mapUiLanguageToSpeechLocale(uiLanguage: string): string {
  switch (uiLanguage) {
    case "zh-CN":
      return "zh-CN";
    case "ko":
      return "ko-KR";
    case "es":
      return "es-ES";
    case "pt":
      return "pt-BR";
    case "vi":
      return "vi-VN";
    case "tl":
      return "fil-PH";
    default:
      return "en-US";
  }
}

function findLatestAssistantMessage(messages: ConversationMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim());
}

/* ── Companion speech memory ───────────────────────────────────────── */

type CompanionSpeechMemoryEntry = {
  messageId: string;
  text: string;
};

type VoiceLatencyState = {
  assistantFirstMessageId: string | null;
  firstSegmentCached: boolean | null;
  speechEndToFirstTokenMs: number | null;
  speechEndToVoiceStartMs: number | null;
  assistantStreamToVoiceStartMs: number | null;
};

type PendingVoiceTurnState = {
  id: string;
  expiresAtMs: number;
  firstSegmentCached?: boolean;
  firstTokenAtMs?: number;
  assistantFirstMessageId?: string;
  assistantFirstTextAtMs?: number;
  speechEndedAtMs: number;
  voiceStartedAtMs?: number;
};

function makeVoiceTurnId(speechEndedAtMs: number): string {
  return `voice-turn-${Math.round(speechEndedAtMs)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

const companionSpeechMemoryByConversation = new Map<
  string,
  CompanionSpeechMemoryEntry
>();

function rememberCompanionSpeech(
  conversationId: string | null,
  messageId: string,
  text: string,
): void {
  if (!conversationId) return;
  companionSpeechMemoryByConversation.set(conversationId, { messageId, text });
  if (companionSpeechMemoryByConversation.size <= 100) return;
  const oldestConversationId = companionSpeechMemoryByConversation
    .keys()
    .next().value;
  if (oldestConversationId) {
    companionSpeechMemoryByConversation.delete(oldestConversationId);
  }
}

function hasCompanionSpeechBeenPlayed(
  conversationId: string | null,
  messageId: string,
  text: string,
): boolean {
  if (!conversationId) return false;
  const remembered = companionSpeechMemoryByConversation.get(conversationId);
  return remembered?.messageId === messageId && remembered.text === text;
}

export function __resetCompanionSpeechMemoryForTests(): void {
  companionSpeechMemoryByConversation.clear();
}

/* ── useChatVoiceController ────────────────────────────────────────── */

/**
 * Chat assistant TTS pipeline — order matters for cloud-backed voice:
 * 1. Server exposes Eliza Cloud via `GET /api/cloud/status` (`hasApiKey`, `enabled`, `connected`).
 * 2. `AppContext.pollCloudCredits` persists React state and dispatches {@link ELIZA_CLOUD_STATUS_UPDATED_EVENT}.
 * 3. This hook stores `detail.cloudVoiceProxyAvailable` in a ref for same-turn
 *    `true` before React state commits; `cloudConnected` is `context || ref===true`
 *    so an early `false` snapshot cannot block TTS after auth loads. Then reloads
 *    `messages.tts` from `getConfig`.
 * 4. `useVoiceChat` resolves cloud vs own-key mode and speaks via `/api/tts/cloud`
 *    only when cloud inference is actually selected, not merely linked.
 */
export function useChatVoiceController(options: {
  agentVoiceMuted: boolean;
  chatFirstTokenReceived: boolean;
  chatInput: string;
  chatSending: boolean;
  elizaCloudConnected: boolean;
  elizaCloudVoiceProxyAvailable: boolean;
  elizaCloudHasPersistedKey: boolean;
  conversationMessages: ConversationMessage[];
  activeConversationId: string | null;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  handleChatSend: (
    channelType?: ConversationChannelType,
    options?: { metadata?: Record<string, unknown> },
  ) => Promise<void>;
  isComposerLocked: boolean;
  isGameModal: boolean;
  setState: ReturnType<typeof useApp>["setState"];
  uiLanguage: string;
}) {
  const { setTimeout } = useTimeout();
  const { avatarReady: companionSceneAvatarReady } = useCompanionSceneStatus();
  const {
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
  } = options;
  /** After the first `eliza:cloud-status-updated`, mirrors server `cloudVoiceProxyAvailable` (avoids one-frame lag vs context). */
  const [cloudVoiceSnapshot, setCloudVoiceSnapshot] = useState<boolean | null>(
    null,
  );
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  /** Bumps after each `getConfig` (or inline VOICE_CONFIG event) settles — game-modal auto-speak waits for this so TTS does not run with a stale/null voice profile and get stuck deduped. */
  const [voiceBootstrapTick, setVoiceBootstrapTick] = useState(0);
  const [voiceLatency, setVoiceLatency] = useState<VoiceLatencyState | null>(
    null,
  );
  const pendingVoiceTurnRef = useRef<PendingVoiceTurnState | null>(null);
  const suppressedAssistantSpeechIdRef = useRef<string | null>(null);
  /** Skips duplicate companion auto-speak when only `voiceBootstrapTick` bumps (config/cloud reload) for the same assistant text. */
  const companionBootstrapAutoSpeakRef = useRef<{
    tick: number;
    messageId: string;
    text: string;
    unlockGen: number;
  } | null>(null);
  const initialCompletedAssistantOnGameModalMountRef = useRef<{
    messageId: string;
    text: string;
  } | null>(
    isGameModal && !chatSending
      ? (() => {
          const latestAssistant =
            findLatestAssistantMessage(conversationMessages);
          if (!latestAssistant) return null;
          return {
            messageId: latestAssistant.id,
            text: latestAssistant.text,
          };
        })()
      : null,
  );
  const voiceDraftBaseInputRef = useRef("");
  const prevIsGameModalRef = useRef(isGameModal);
  const gameModalJustActivatedRef = useRef(false);

  const loadVoiceConfig = useCallback(async () => {
    try {
      const cfg = await client.getConfig();
      const resolved = resolveCharacterVoiceConfigFromAppConfig({
        config: cfg,
        uiLanguage,
      });
      setVoiceConfig(resolved.voiceConfig);
      if (resolved.shouldPersist && resolved.voiceConfig) {
        void client
          .updateConfig({
            messages: {
              tts: resolved.voiceConfig,
            },
          })
          .catch(() => {});
      }
    } catch {
      /* ignore — will use browser TTS fallback */
      setVoiceConfig(null);
    } finally {
      setVoiceBootstrapTick((t) => t + 1);
    }
  }, [uiLanguage]);

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
        setVoiceBootstrapTick((t) => t + 1);
        return;
      }
      void loadVoiceConfig();
    };

    window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
    return () =>
      window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
  }, [loadVoiceConfig]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onCloudStatus = (event: Event) => {
      const detail = (event as CustomEvent<ElizaCloudStatusUpdatedDetail>)
        .detail;
      if (detail && typeof detail === "object") {
        ttsDebug("chat:cloud-status-event", {
          cloudVoiceProxyAvailable: detail.cloudVoiceProxyAvailable,
          connected: detail.connected,
          enabled: detail.enabled,
          hasPersistedApiKey: detail.hasPersistedApiKey,
        });
      }
      if (detail && typeof detail.cloudVoiceProxyAvailable === "boolean") {
        setCloudVoiceSnapshot(detail.cloudVoiceProxyAvailable);
      }
      void loadVoiceConfig();
    };
    window.addEventListener(ELIZA_CLOUD_STATUS_UPDATED_EVENT, onCloudStatus);
    return () =>
      window.removeEventListener(
        ELIZA_CLOUD_STATUS_UPDATED_EVENT,
        onCloudStatus,
      );
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
    (text: string, event?: VoiceTranscriptEvent) => {
      if (isComposerLocked) return;
      const composedText = composeVoiceDraft(text);
      if (!composedText) return;
      const speechEndedAtMs = nowMs();
      const voiceTurnId = event?.turn.id ?? makeVoiceTurnId(speechEndedAtMs);
      pendingVoiceTurnRef.current = {
        id: voiceTurnId,
        expiresAtMs: speechEndedAtMs + 15000,
        speechEndedAtMs,
      };
      setVoiceLatency(null);
      setState("chatInput", composedText);
      setTimeout(
        () =>
          void handleChatSend("VOICE_DM", {
            metadata: {
              voiceTurnId,
              voiceSpeechEndedAtMs: Math.round(speechEndedAtMs),
              voiceSource: event?.turn.source ?? event?.turn.metadata?.source,
            },
          }),
        50,
      );
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
      ttsDebug("chat:playback-start", {
        provider: event.provider,
        segment: event.segment,
        cached: event.cached,
        messageId: event.messageId,
        voiceTurnId: event.voiceTurnId,
        speechEndToVoiceStartMs:
          event.speechEndedAtMs != null
            ? Math.max(0, Math.round(event.startedAtMs - event.speechEndedAtMs))
            : undefined,
        assistantStreamToVoiceStartMs:
          event.assistantFirstTextAtMs != null
            ? Math.max(
                0,
                Math.round(event.startedAtMs - event.assistantFirstTextAtMs),
              )
            : undefined,
      });
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
        assistantFirstMessageId:
          prev?.assistantFirstMessageId ??
          event.messageId ??
          pending.assistantFirstMessageId ??
          null,
        firstSegmentCached: event.cached,
        speechEndToFirstTokenMs: prev?.speechEndToFirstTokenMs ?? null,
        speechEndToVoiceStartMs: Math.max(
          0,
          Math.round(event.startedAtMs - pending.speechEndedAtMs),
        ),
        assistantStreamToVoiceStartMs:
          event.assistantFirstTextAtMs != null
            ? Math.max(
                0,
                Math.round(event.startedAtMs - event.assistantFirstTextAtMs),
              )
            : (prev?.assistantStreamToVoiceStartMs ?? null),
      }));
    },
    [],
  );

  const cloudVoiceAvailable = useMemo(() => {
    const fromContext = elizaCloudVoiceProxyAvailable;
    // Ref snapshot can be `false` from an early status poll before the key is
    // loaded, then never updated if no further event fires. Prefer the
    // committed `enabled` state; only use the event snapshot to force `true`
    // when it arrives before the wider app state catches up.
    return fromContext || cloudVoiceSnapshot === true;
  }, [cloudVoiceSnapshot, elizaCloudVoiceProxyAvailable]);

  useEffect(() => {
    ttsDebug("chat:cloud-voice-available", {
      cloudVoiceAvailable,
      elizaCloudConnected,
      elizaCloudVoiceProxyAvailable,
      elizaCloudHasPersistedKey,
      snapshotValue: cloudVoiceSnapshot,
    });
  }, [
    cloudVoiceAvailable,
    cloudVoiceSnapshot,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
    elizaCloudHasPersistedKey,
  ]);

  const voice = useVoiceChat({
    cloudConnected: cloudVoiceAvailable,
    interruptOnSpeech: isGameModal,
    lang: mapUiLanguageToSpeechLocale(uiLanguage),
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
    voiceUnlockedGeneration,
  } = voice;

  // After the user gesture unlocks audio, clear progressive TTS dedupe state so
  // auto-speak can queue the greeting again (ElevenLabs was likely skipped once).
  const prevVoiceUnlockGenRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (prevVoiceUnlockGenRef.current === null) {
      prevVoiceUnlockGenRef.current = voiceUnlockedGeneration;
      return;
    }
    if (prevVoiceUnlockGenRef.current === voiceUnlockedGeneration) return;
    prevVoiceUnlockGenRef.current = voiceUnlockedGeneration;
    stopSpeaking();
  }, [voiceUnlockedGeneration, stopSpeaking]);

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
      rememberCompanionSpeech(activeConversationId, messageId, text);
      speak(text);
    },
    [activeConversationId, speak],
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
  // NOTE: Do NOT suppress on the initial mount — only on actual mode switches.
  const hasSetInitialGameModalRef = useRef(false);
  useEffect(() => {
    if (!hasSetInitialGameModalRef.current) {
      // First render — just record the initial value without suppressing.
      hasSetInitialGameModalRef.current = true;
      prevIsGameModalRef.current = isGameModal;
      return;
    }
    if (isGameModal && !prevIsGameModalRef.current) {
      gameModalJustActivatedRef.current = true;
    }
    prevIsGameModalRef.current = isGameModal;
  }, [isGameModal]);

  useEffect(() => {
    if (!isGameModal) {
      companionBootstrapAutoSpeakRef.current = null;
    }
  }, [isGameModal]);

  useEffect(() => {
    let pendingVoiceTurn = pendingVoiceTurnRef.current;
    if (pendingVoiceTurn && nowMs() > pendingVoiceTurn.expiresAtMs) {
      pendingVoiceTurnRef.current = null;
      pendingVoiceTurn = null;
    }

    const shouldSpeakVisibleOutput = isGameModal || pendingVoiceTurn != null;
    if (!shouldSpeakVisibleOutput || agentVoiceMuted || voice.isListening) {
      return;
    }
    if (isGameModal && !companionSceneAvatarReady) return;
    if (voiceBootstrapTick === 0) return;
    // Skip the stale replay when the view just became active (mode switch).
    if (isGameModal && gameModalJustActivatedRef.current) {
      gameModalJustActivatedRef.current = false;
      return;
    }
    const latestAssistant = findLatestAssistantMessage(conversationMessages);
    if (!latestAssistant) return;
    if (suppressedAssistantSpeechIdRef.current === latestAssistant.id) return;

    const tick = voiceBootstrapTick;
    const messageId = latestAssistant.id;
    const text = latestAssistant.text;
    const ug = voiceUnlockedGeneration;
    const initialCompletedAssistant =
      initialCompletedAssistantOnGameModalMountRef.current;
    if (
      initialCompletedAssistant &&
      !chatSending &&
      initialCompletedAssistant.messageId === messageId &&
      initialCompletedAssistant.text === text
    ) {
      initialCompletedAssistantOnGameModalMountRef.current = null;
      companionBootstrapAutoSpeakRef.current = {
        tick,
        messageId,
        text,
        unlockGen: ug,
      };
      return;
    }
    if (initialCompletedAssistant) {
      initialCompletedAssistantOnGameModalMountRef.current = null;
    }
    const prev = companionBootstrapAutoSpeakRef.current;
    const sameQueuedVisibleText =
      prev &&
      prev.messageId === messageId &&
      prev.text === text &&
      prev.unlockGen === ug;
    if (
      hasCompanionSpeechBeenPlayed(activeConversationId, messageId, text) &&
      !sameQueuedVisibleText
    ) {
      companionBootstrapAutoSpeakRef.current = {
        tick,
        messageId,
        text,
        unlockGen: ug,
      };
      return;
    }
    if (
      prev &&
      prev.messageId === messageId &&
      prev.text === text &&
      prev.unlockGen === ug
    ) {
      if (tick > prev.tick) {
        // Voice config / cloud status bumped the tick only — do not re-queue the same line.
        companionBootstrapAutoSpeakRef.current = {
          tick,
          messageId,
          text,
          unlockGen: ug,
        };
        return;
      }
      if (tick === prev.tick && chatSending) {
        // Same deps re-run (e.g. React Strict Mode dev double effect) — already queued.
        return;
      }
    }

    const textUpdatedAtMs = nowMs();
    let telemetry: VoiceAssistantSpeechTelemetry | undefined;
    let replacePlayback = true;

    if (pendingVoiceTurn) {
      if (pendingVoiceTurn.assistantFirstTextAtMs == null) {
        pendingVoiceTurn.assistantFirstTextAtMs = textUpdatedAtMs;
        pendingVoiceTurn.assistantFirstMessageId = messageId;
      }
      if (pendingVoiceTurn.firstTokenAtMs == null) {
        pendingVoiceTurn.firstTokenAtMs = textUpdatedAtMs;
        setVoiceLatency((prev) => ({
          assistantFirstMessageId: messageId,
          firstSegmentCached: prev?.firstSegmentCached ?? null,
          speechEndToFirstTokenMs: Math.max(
            0,
            Math.round(textUpdatedAtMs - pendingVoiceTurn.speechEndedAtMs),
          ),
          speechEndToVoiceStartMs: prev?.speechEndToVoiceStartMs ?? null,
          assistantStreamToVoiceStartMs:
            prev?.assistantStreamToVoiceStartMs ?? null,
        }));
      }
      replacePlayback =
        pendingVoiceTurn.assistantFirstMessageId == null ||
        pendingVoiceTurn.assistantFirstMessageId === messageId;
      telemetry = {
        messageId,
        voiceTurnId: pendingVoiceTurn.id,
        speechEndedAtMs: pendingVoiceTurn.speechEndedAtMs,
        assistantFirstTextAtMs:
          pendingVoiceTurn.assistantFirstTextAtMs ?? textUpdatedAtMs,
        assistantTextUpdatedAtMs: textUpdatedAtMs,
      };
    }

    queueAssistantSpeech(messageId, text, !chatSending, {
      replace: replacePlayback,
      telemetry,
    });
    rememberCompanionSpeech(activeConversationId, messageId, text);
    suppressedAssistantSpeechIdRef.current = null;
    companionBootstrapAutoSpeakRef.current = {
      tick,
      messageId,
      text,
      unlockGen: ug,
    };
  }, [
    agentVoiceMuted,
    activeConversationId,
    chatSending,
    companionSceneAvatarReady,
    conversationMessages,
    isGameModal,
    queueAssistantSpeech,
    voice.isListening,
    voiceBootstrapTick,
    voiceUnlockedGeneration,
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
      assistantFirstMessageId:
        prev?.assistantFirstMessageId ??
        pending.assistantFirstMessageId ??
        null,
      firstSegmentCached: prev?.firstSegmentCached ?? null,
      speechEndToFirstTokenMs: Math.max(
        0,
        Math.round(firstTokenAtMs - pending.speechEndedAtMs),
      ),
      speechEndToVoiceStartMs: prev?.speechEndToVoiceStartMs ?? null,
      assistantStreamToVoiceStartMs:
        prev?.assistantStreamToVoiceStartMs ?? null,
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

/* ── useGameModalMessages ──────────────────────────────────────────── */

export interface CompanionCarryoverState {
  expiresAtMs: number;
  fadeStartsAtMs: number;
  messages: ConversationMessage[];
}

export function useGameModalMessages(options: {
  activeConversationId: string | null;
  companionMessageCutoffTs: number;
  isGameModal: boolean;
  visibleMsgs: ConversationMessage[];
}) {
  const {
    activeConversationId,
    companionMessageCutoffTs,
    isGameModal,
    visibleMsgs,
  } = options;
  const previousCompanionCutoffTsRef = useRef(companionMessageCutoffTs);
  const previousGameModalVisibleMsgsRef = useRef<ConversationMessage[]>([]);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const [companionNowMs, setCompanionNowMs] = useState(() => Date.now());
  const [companionCarryover, setCompanionCarryover] =
    useState<CompanionCarryoverState | null>(null);
  const docVisible = useDocumentVisibility();

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
      return;
    }

    if (previousActiveConversationIdRef.current === activeConversationId) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    previousGameModalVisibleMsgsRef.current = [];
    previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
    setCompanionCarryover(null);
    // NOTE: intentionally no stopSpeaking() here — the auto-speak effect's
    // queueAssistantSpeech already cancels old speech before queuing new.
    // Calling stopSpeaking() races with greeting speech and kills it.
  }, [activeConversationId, companionMessageCutoffTs, isGameModal]);

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

    if (!docVisible) return () => {};

    const intervalId = window.setInterval(tick, 250);
    return () => window.clearInterval(intervalId);
  }, [companionCarryover, docVisible]);

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
