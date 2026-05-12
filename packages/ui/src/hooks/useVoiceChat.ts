/**
 * Bidirectional voice hook for chat + avatar lip sync.
 *
 * TTS providers (in priority order):
 *  1. ElevenLabs  — streaming endpoint; assistant replies enqueue text deltas as
 *     the stream grows (no sentence-boundary wait — lower time-to-first-audio).
 *  2. Browser SpeechSynthesis — fallback when ElevenLabs isn't configured.
 *
 * STT: Web Speech API (SpeechRecognition) for user voice input.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor } from "@capacitor/core";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { VoiceConfig } from "../api/client";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
} from "../bridge/electrobun-rpc";
import {
  getTalkModePlugin,
  type TalkModeErrorEvent,
  type TalkModeStateEvent,
  type TalkModeTranscriptEvent,
} from "../bridge/native-plugins";
import { resolveApiUrl } from "../utils";
import { getElizaApiToken } from "../utils/eliza-globals";
import {
  isTtsDebugEnabled,
  ttsDebug,
  ttsDebugTextPreview,
} from "../utils/tts-debug";
import { hasConfiguredApiKey } from "../voice";
import {
  collapseWhitespace,
  nextIdleMouthOpen,
  normalizeCacheText,
  normalizeMouthOpen,
  queueableSpeechPrefix,
  remainderAfter,
  shouldCacheGeneratedSpeech,
  splitFirstSentence,
  toSpeakableText,
} from "../voice/voice-chat-playback";
import { mergeTranscriptWindows } from "../voice/voice-chat-recording";
import {
  ASSISTANT_TTS_DEBOUNCE_MS,
  ASSISTANT_TTS_FINAL_ONLY,
  ASSISTANT_TTS_FIRST_FLUSH_CHARS,
  ASSISTANT_TTS_MIN_CHUNK_CHARS,
  type AssistantSpeechState,
  DEFAULT_ELEVEN_MODEL,
  DEFAULT_ELEVEN_VOICE,
  describeTtsCloudFetchTargetForDebug,
  getSpeechRecognitionCtor,
  globalAudioCache,
  isAbortError,
  localePrefix,
  MAX_CACHED_SEGMENTS,
  matchesVoiceLocale,
  normalizeSpeechLocale,
  type QueueAssistantSpeechOptions,
  resolveEffectiveVoiceConfig,
  resolveVoiceMode,
  resolveVoiceProxyEndpoint,
  type SpeakTask,
  type SpeechRecognitionInstance,
  type SpeechRecognitionResultEvent,
  TALKMODE_STOP_SETTLE_MS,
  toArrayBuffer,
  type VoiceCaptureMode,
  type VoiceChatOptions,
  type VoiceChatState,
  type VoicePlaybackStartEvent,
  type VoiceSessionMode,
  type VoiceSpeakerMetadata,
  type VoiceTranscriptEvent,
  type VoiceTranscriptPreviewEvent,
  type VoiceTurn,
  webSpeechVoiceDebugFields,
} from "../voice/voice-chat-types";

// ── Re-exports (public API) ──────────────────────────────────────────

export { nextIdleMouthOpen } from "../voice/voice-chat-playback";
export type {
  QueueAssistantSpeechOptions,
  VoiceAssistantSpeechTelemetry,
  VoiceCaptureMode,
  VoiceChatOptions,
  VoiceChatState,
  VoicePlaybackStartEvent,
  VoiceSessionMode,
  VoiceSpeakerMetadata,
  VoiceTranscriptEvent,
  VoiceTranscriptPreviewEvent,
  VoiceTurn,
} from "../voice/voice-chat-types";

// ── Shared mutable state ─────────────────────────────────────────────

let sharedAudioCtx: AudioContext | null = null;

// ── Internal helpers ─────────────────────────────────────────────────

function shouldPreferNativeTalkMode(): boolean {
  if (typeof window === "undefined") return false;
  return Capacitor.isNativePlatform() || !!getElectrobunRendererRpc();
}

function isWindowsElectrobunRenderer(): boolean {
  return (
    typeof window !== "undefined" &&
    !!getElectrobunRendererRpc() &&
    typeof process !== "undefined" &&
    process.platform === "win32"
  );
}

function shouldAutoRestartBrowserRecognition(): boolean {
  if (typeof window === "undefined") return false;
  if (isWindowsElectrobunRenderer()) {
    return false;
  }
  return true;
}

const ACTIVE_VOICE_SESSION_MODES = new Set<Exclude<VoiceSessionMode, "idle">>([
  "compose",
  "push-to-talk",
  "hands-free",
  "passive",
]);

function normalizeActiveVoiceSessionMode(
  mode: unknown,
): Exclude<VoiceSessionMode, "idle"> | null {
  return typeof mode === "string" &&
    ACTIVE_VOICE_SESSION_MODES.has(mode as Exclude<VoiceSessionMode, "idle">)
    ? (mode as Exclude<VoiceSessionMode, "idle">)
    : null;
}

interface VoiceTranscriptUpdateMetadata {
  mode?: Exclude<VoiceSessionMode, "idle">;
  speaker?: VoiceSpeakerMetadata;
  source?: string;
  confidence?: number;
  turn?: Partial<VoiceTurn>;
  metadata?: Record<string, unknown>;
}

// ── Test-visible internals ───────────────────────────────────────────

export const __voiceChatInternals = {
  isWindowsElectrobunRenderer,
  shouldPreferNativeTalkMode,
  shouldAutoRestartBrowserRecognition,
  splitFirstSentence,
  remainderAfter,
  queueableSpeechPrefix,
  resolveEffectiveVoiceConfig,
  resolveVoiceMode,
  resolveVoiceProxyEndpoint,
  toSpeakableText,
  mergeTranscriptWindows,
  webSpeechVoiceDebugFields,
  ASSISTANT_TTS_FINAL_ONLY,
  ASSISTANT_TTS_FIRST_FLUSH_CHARS,
  ASSISTANT_TTS_MIN_CHUNK_CHARS,
};

// ── Hook ──────────────────────────────────────────────────────────────

export function useVoiceChat(options: VoiceChatOptions): VoiceChatState {
  const [isListening, setIsListening] = useState(false);
  const [captureMode, setCaptureMode] = useState<VoiceCaptureMode>("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [supported, setSupported] = useState(false);
  const [usingAudioAnalysis, setUsingAudioAnalysis] = useState(false);
  const [voiceUnlockedGeneration, setVoiceUnlockedGeneration] = useState(0);

  // Refs — stable across renders, read from animation loop & callbacks
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const sttBackendRef = useRef<"browser" | "talkmode" | null>(null);
  const talkModeHandlesRef = useRef<PluginListenerHandle[]>([]);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const animFrameRef = useRef<number>(0);
  const speakingStartRef = useRef<number>(0);
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(false);
  const listeningModeRef = useRef<VoiceCaptureMode>("idle");
  const transcriptBufferRef = useRef("");
  const latestTranscriptTurnRef = useRef<VoiceTurn | null>(null);
  const emitTranscript = useEffectEvent(
    (text: string, event: VoiceTranscriptEvent) => {
      options.onTranscript(text, event);
    },
  );
  const emitTranscriptPreview = useEffectEvent(
    (text: string, event: VoiceTranscriptPreviewEvent) => {
      options.onTranscriptPreview?.(text, event);
    },
  );
  const emitPlaybackStart = useEffectEvent((event: VoicePlaybackStartEvent) => {
    options.onPlaybackStart?.(event);
  });

  const effectiveVoiceConfig = useMemo(
    () =>
      resolveEffectiveVoiceConfig(options.voiceConfig, {
        cloudConnected: options.cloudConnected,
      }),
    [options.cloudConnected, options.voiceConfig],
  );

  const assistantTtsQuality = useMemo((): "enhanced" | "standard" => {
    return effectiveVoiceConfig?.provider === "elevenlabs"
      ? "enhanced"
      : "standard";
  }, [effectiveVoiceConfig?.provider]);

  const ttsDebugConfigKeyRef = useRef("");
  useEffect(() => {
    const key = JSON.stringify({
      c: options.cloudConnected,
      p: effectiveVoiceConfig?.provider,
      m: effectiveVoiceConfig?.mode,
      v: effectiveVoiceConfig?.elevenlabs?.voiceId,
      q: assistantTtsQuality,
    });
    if (ttsDebugConfigKeyRef.current === key) return;
    ttsDebugConfigKeyRef.current = key;
    ttsDebug("useVoiceChat:config", {
      cloudConnected: options.cloudConnected,
      provider: effectiveVoiceConfig?.provider,
      mode: effectiveVoiceConfig?.mode,
      voiceId: effectiveVoiceConfig?.elevenlabs?.voiceId,
      assistantTtsQuality,
      ttsCloudUrl: resolveApiUrl("/api/tts/cloud"),
    });
  }, [
    assistantTtsQuality,
    effectiveVoiceConfig?.elevenlabs?.voiceId,
    effectiveVoiceConfig?.mode,
    effectiveVoiceConfig?.provider,
    options.cloudConnected,
  ]);

  // Voice config ref (latest value always available to callbacks)
  const voiceConfigRef = useRef<VoiceConfig | null>(effectiveVoiceConfig);
  voiceConfigRef.current = effectiveVoiceConfig;
  const interruptOnSpeechRef = useRef(options.interruptOnSpeech ?? true);
  interruptOnSpeechRef.current = options.interruptOnSpeech ?? true;
  const interruptSpeechRef = useRef<() => void>(() => {});

  // ── ElevenLabs Web Audio refs ──────────────────────────────────────
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const timeDomainDataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const usingAudioAnalysisRef = useRef(false);
  const mouthOpenRef = useRef(0);
  mouthOpenRef.current = mouthOpen;

  // ── Progressive speech queue state ────────────────────────────────
  const queueRef = useRef<SpeakTask[]>([]);
  const queueWorkerRunningRef = useRef(false);
  const generationRef = useRef(0);
  const activeTaskFinishRef = useRef<(() => void) | null>(null);
  const activeFetchAbortRef = useRef<AbortController | null>(null);
  const assistantSpeechRef = useRef<AssistantSpeechState | null>(null);
  const assistantTtsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearSpeechTimers = useCallback(() => {
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
  }, []);

  const rememberCachedSegment = useCallback(
    (key: string, bytes: Uint8Array) => {
      globalAudioCache.delete(key);
      globalAudioCache.set(key, bytes);
      if (globalAudioCache.size <= MAX_CACHED_SEGMENTS) return;
      const oldest = globalAudioCache.keys().next().value;
      if (oldest) globalAudioCache.delete(oldest);
    },
    [],
  );

  const makeElevenCacheKey = useCallback(
    (text: string, config: NonNullable<VoiceConfig["elevenlabs"]>) => {
      const voiceId = config.voiceId ?? DEFAULT_ELEVEN_VOICE;
      const modelId = config.modelId ?? DEFAULT_ELEVEN_MODEL;
      const stability =
        typeof config.stability === "number"
          ? config.stability.toFixed(2)
          : "0.50";
      const similarity =
        typeof config.similarityBoost === "number"
          ? config.similarityBoost.toFixed(2)
          : "0.75";
      const speed =
        typeof config.speed === "number" ? config.speed.toFixed(2) : "1.00";
      return [
        "elevenlabs",
        voiceId,
        modelId,
        stability,
        similarity,
        speed,
        normalizeCacheText(text),
      ].join("|");
    },
    [],
  );

  const makeLocalInferenceCacheKey = useCallback(
    (text: string) => ["local-inference", normalizeCacheText(text)].join("|"),
    [],
  );

  const updateMouthOpen = useCallback(
    (value: number | ((previousValue: number) => number)) => {
      const previousValue = mouthOpenRef.current;
      const resolvedValue =
        typeof value === "function" ? value(previousValue) : value;
      const nextValue = normalizeMouthOpen(resolvedValue);
      if (nextValue === previousValue) {
        return;
      }
      mouthOpenRef.current = nextValue;
      setMouthOpen(nextValue);
    },
    [],
  );

  // ── Init ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const syncVoiceSupport = async () => {
      const browserSpeechSupported = !!getSpeechRecognitionCtor();
      if (!shouldPreferNativeTalkMode()) {
        if (!cancelled) {
          setSupported(browserSpeechSupported);
        }
        return;
      }

      try {
        const permissions = await getTalkModePlugin().checkPermissions();
        if (cancelled) {
          return;
        }
        setSupported(
          permissions.speechRecognition !== "not_supported" ||
            browserSpeechSupported,
        );
      } catch {
        if (!cancelled) {
          setSupported(browserSpeechSupported);
        }
      }
    };

    void syncVoiceSupport();
    synthRef.current = window.speechSynthesis ?? null;

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Mouth animation loop ──────────────────────────────────────────

  useEffect(() => {
    let frameId = 0;

    const animate = () => {
      if (!isSpeaking) {
        const nextMouth = nextIdleMouthOpen(mouthOpenRef.current);
        updateMouthOpen(nextMouth);
        if (nextMouth > 0) {
          frameId = requestAnimationFrame(animate);
          animFrameRef.current = frameId;
        } else {
          animFrameRef.current = 0;
        }
        return;
      }

      // ── ElevenLabs: real audio volume analysis ────────────────────
      if (usingAudioAnalysisRef.current) {
        const analyser = analyserRef.current;
        const data = timeDomainDataRef.current;
        if (analyser && data) {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i] ?? 0;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const volume = Math.max(
            0,
            Math.min(1, 1 / (1 + Math.exp(-(rms * 30 - 2)))),
          );
          updateMouthOpen(volume);
        }
        frameId = requestAnimationFrame(animate);
        animFrameRef.current = frameId;
        return;
      }

      // ── Browser TTS: sine-wave mouth + safety check ──────────────
      const sinceStart = Date.now() - speakingStartRef.current;
      if (
        sinceStart > 500 &&
        synthRef.current &&
        !synthRef.current.speaking &&
        !synthRef.current.pending
      ) {
        utteranceRef.current = null;
        setIsSpeaking(false);
        return;
      }

      const elapsed = sinceStart / 1000;
      const base = Math.sin(elapsed * 12) * 0.3 + 0.4;
      const detail = Math.sin(elapsed * 18.7) * 0.15;
      const slow = Math.sin(elapsed * 4.2) * 0.1;
      updateMouthOpen(Math.max(0, Math.min(1, base + detail + slow)));
      frameId = requestAnimationFrame(animate);
      animFrameRef.current = frameId;
    };

    if (isSpeaking || mouthOpenRef.current > 0) {
      frameId = requestAnimationFrame(animate);
      animFrameRef.current = frameId;
    } else {
      animFrameRef.current = 0;
    }

    return () => {
      cancelAnimationFrame(frameId);
      if (animFrameRef.current === frameId) {
        animFrameRef.current = 0;
      }
    };
  }, [isSpeaking, updateMouthOpen]);

  // ── STT (Speech Recognition) ──────────────────────────────────────

  const applyTranscriptUpdate = useCallback(
    (
      transcript: string,
      isFinal: boolean,
      metadata: VoiceTranscriptUpdateMetadata = {},
    ) => {
      const mode = metadata.mode ?? listeningModeRef.current;
      if (mode === "idle") return;

      const normalized = collapseWhitespace(transcript);
      if (!normalized) return;

      const nextText = mergeTranscriptWindows(
        transcriptBufferRef.current,
        normalized,
      );
      if (nextText === transcriptBufferRef.current) return;

      transcriptBufferRef.current = nextText;
      setInterimTranscript(nextText);
      const turn: VoiceTurn = {
        ...metadata.turn,
        text: nextText,
        mode,
        isFinal,
        speaker: metadata.speaker ?? metadata.turn?.speaker,
        source:
          metadata.source ??
          metadata.turn?.source ??
          sttBackendRef.current ??
          undefined,
        confidence: metadata.confidence ?? metadata.turn?.confidence,
        metadata: metadata.metadata ?? metadata.turn?.metadata,
      };
      latestTranscriptTurnRef.current = turn;
      emitTranscriptPreview(nextText, {
        text: nextText,
        mode,
        isFinal,
        turn,
        speaker: turn.speaker,
      });

      if (interruptOnSpeechRef.current) {
        interruptSpeechRef.current();
      }
    },
    [],
  );

  const removeTalkModeListeners = useCallback(async () => {
    const handles = talkModeHandlesRef.current;
    talkModeHandlesRef.current = [];
    await Promise.all(
      handles.map((handle) =>
        handle.remove().catch(() => {
          /* ignore */
        }),
      ),
    );
  }, []);

  const resetListeningState = useCallback(() => {
    transcriptBufferRef.current = "";
    latestTranscriptTurnRef.current = null;
    recognitionRef.current = null;
    sttBackendRef.current = null;
    enabledRef.current = false;
    listeningModeRef.current = "idle";
    setIsListening(false);
    setCaptureMode("idle");
    setInterimTranscript("");
  }, []);

  const ensureTalkModeListeners = useCallback(async () => {
    if (talkModeHandlesRef.current.length > 0) return;

    const talkMode = getTalkModePlugin();

    const transcriptHandle = await talkMode.addListener(
      "transcript",
      (event: TalkModeTranscriptEvent) => {
        const typedEvent = event as TalkModeTranscriptEvent & {
          mode?: unknown;
          speaker?: VoiceSpeakerMetadata;
          turn?: Partial<VoiceTurn>;
          source?: string;
          confidence?: number;
          metadata?: Record<string, unknown>;
        };
        applyTranscriptUpdate(event.transcript ?? "", event.isFinal === true, {
          mode: normalizeActiveVoiceSessionMode(typedEvent.mode) ?? undefined,
          speaker: typedEvent.speaker,
          source: typedEvent.source,
          confidence: typedEvent.confidence,
          turn: typedEvent.turn,
          metadata: typedEvent.metadata,
        });
      },
    );
    const errorHandle = await talkMode.addListener(
      "error",
      (event: TalkModeErrorEvent) => {
        if (
          sttBackendRef.current === "talkmode" ||
          event.code === "not-allowed" ||
          event.code === "service-not-allowed"
        ) {
          resetListeningState();
          if (
            event.code === "not-allowed" ||
            event.code === "service-not-allowed"
          ) {
            setSupported(false);
          }
        }
      },
    );
    const stateHandle = await talkMode.addListener(
      "stateChange",
      (event: TalkModeStateEvent) => {
        if (
          (event.state === "error" || event.state === "idle") &&
          sttBackendRef.current === "talkmode"
        ) {
          resetListeningState();
        }
      },
    );
    talkModeHandlesRef.current = [transcriptHandle, errorHandle, stateHandle];
  }, [applyTranscriptUpdate, resetListeningState]);

  const startBrowserRecognition = useCallback(
    (mode: Exclude<VoiceCaptureMode, "idle">) => {
      const SpeechRecognitionAPI = getSpeechRecognitionCtor();
      if (!SpeechRecognitionAPI) return false;

      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = options.lang ?? "en-US";

      recognition.onresult = (event: SpeechRecognitionResultEvent) => {
        let transcript = "";
        let isFinal = false;

        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const chunk = result?.[0]?.transcript ?? "";
          if (chunk) {
            transcript = transcript ? `${transcript} ${chunk}` : chunk;
          }
          if (result?.isFinal) {
            isFinal = true;
          }
        }

        applyTranscriptUpdate(transcript, isFinal);
      };

      recognition.onerror = (event: { error: string }) => {
        if (
          event.error === "not-allowed" ||
          event.error === "service-not-allowed"
        ) {
          enabledRef.current = false;
          listeningModeRef.current = "idle";
          sttBackendRef.current = null;
          setCaptureMode("idle");
          setIsListening(false);
        }
      };

      recognition.onend = () => {
        if (
          shouldAutoRestartBrowserRecognition() &&
          enabledRef.current &&
          listeningModeRef.current === mode
        ) {
          try {
            recognition.start();
          } catch {
            /* already started */
          }
        }
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        sttBackendRef.current = "browser";
        enabledRef.current = true;
        listeningModeRef.current = mode;
        setCaptureMode(mode);
        setIsListening(true);
        return true;
      } catch {
        recognitionRef.current = null;
        return false;
      }
    },
    [applyTranscriptUpdate, options.lang],
  );

  const startTalkModeRecognition = useCallback(
    async (mode: Exclude<VoiceCaptureMode, "idle">) => {
      if (!shouldPreferNativeTalkMode()) {
        return false;
      }

      await ensureTalkModeListeners();

      try {
        const talkMode = getTalkModePlugin();
        const browserSpeechSupported = !!getSpeechRecognitionCtor();
        let permissions = await talkMode.checkPermissions().catch(() => null);
        const nativeSpeechSupported =
          permissions?.speechRecognition !== "not_supported";
        if (!nativeSpeechSupported && !browserSpeechSupported) {
          console.warn(
            "[useVoiceChat] No desktop or browser speech backend is available.",
          );
          setSupported(false);
          return false;
        }

        if (permissions?.microphone === "prompt" && nativeSpeechSupported) {
          await talkMode.requestPermissions().catch(() => {
            /* ignore */
          });
          permissions = await talkMode
            .checkPermissions()
            .catch(() => permissions);
        }

        const directRpc = getElectrobunRendererRpc();
        const result = await talkMode.start({
          config: {
            stt: {
              ...(directRpc ? { engine: "whisper" as const } : {}),
              language: options.lang ?? "en-US",
              modelSize: "base",
              sampleRate: 16000,
            },
            silenceWindowMs: 350,
            interruptOnSpeech: true,
          },
        });
        if (!result.started) {
          console.warn("[useVoiceChat] TalkMode start returned not started.", {
            browserSpeechSupported,
            error: result.error,
          });
          if (!browserSpeechSupported) {
            setSupported(false);
          }
          return false;
        }

        setSupported(true);
        enabledRef.current = true;
        listeningModeRef.current = mode;
        sttBackendRef.current = "talkmode";
        setCaptureMode(mode);
        setIsListening(true);
        return true;
      } catch (error) {
        console.warn("[useVoiceChat] TalkMode start failed.", error);
        return false;
      }
    },
    [ensureTalkModeListeners, options.lang],
  );

  const finalizeRecognition = useCallback(
    (submit: boolean) => {
      const mode =
        normalizeActiveVoiceSessionMode(listeningModeRef.current) ?? "compose";
      const transcript = collapseWhitespace(transcriptBufferRef.current);
      if (submit && transcript) {
        const latestTurn = latestTranscriptTurnRef.current;
        const turn: VoiceTurn = {
          ...latestTurn,
          text: transcript,
          mode,
          isFinal: true,
          endedAtMs: latestTurn?.endedAtMs ?? Date.now(),
        };
        emitTranscript(transcript, {
          text: transcript,
          mode,
          isFinal: true,
          turn,
          speaker: turn.speaker,
        });
      }

      resetListeningState();
    },
    [resetListeningState],
  );

  const startListening = useCallback(
    async (mode: Exclude<VoiceCaptureMode, "idle"> = "compose") => {
      if (enabledRef.current) return;

      transcriptBufferRef.current = "";
      setInterimTranscript("");
      if (interruptOnSpeechRef.current) {
        interruptSpeechRef.current();
      }

      if (shouldPreferNativeTalkMode()) {
        const started = await startTalkModeRecognition(mode);
        if (started) {
          return;
        }
      }

      const startedInBrowser = startBrowserRecognition(mode);
      if (!startedInBrowser) {
        console.warn(
          "[useVoiceChat] Voice capture failed to start in both desktop and browser backends.",
        );
      }
    },
    [startBrowserRecognition, startTalkModeRecognition],
  );

  const stopListening = useCallback(
    async (options?: { submit?: boolean }) => {
      const mode = listeningModeRef.current;
      if (mode === "idle") return;

      const submit = options?.submit === true;
      enabledRef.current = false;

      if (sttBackendRef.current === "talkmode") {
        await getTalkModePlugin()
          .stop()
          .catch(() => {
            /* ignore */
          });
        await new Promise((resolve) =>
          window.setTimeout(resolve, TALKMODE_STOP_SETTLE_MS),
        );
      } else {
        recognitionRef.current?.stop();
        await new Promise((resolve) =>
          window.setTimeout(resolve, TALKMODE_STOP_SETTLE_MS),
        );
      }

      finalizeRecognition(submit);
    },
    [finalizeRecognition],
  );

  const toggleListening = useCallback(() => {
    if (enabledRef.current && listeningModeRef.current === "compose") {
      void stopListening();
      return;
    }
    if (enabledRef.current) return;
    void startListening("compose");
  }, [startListening, stopListening]);

  // ── Cancel helpers ────────────────────────────────────────────────

  /** Stop all in-progress speech playback/requests but keep assistant queue state. */
  const cancelPlayback = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];

    activeFetchAbortRef.current?.abort();
    activeFetchAbortRef.current = null;

    activeTaskFinishRef.current?.();
    activeTaskFinishRef.current = null;

    // Browser TTS
    synthRef.current?.cancel();
    utteranceRef.current = null;

    // ElevenLabs audio
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        /* ok */
      }
      try {
        audioSourceRef.current.disconnect();
      } catch {
        /* ok */
      }
      audioSourceRef.current = null;
    }

    clearSpeechTimers();
    usingAudioAnalysisRef.current = false;
    setUsingAudioAnalysis(false);
  }, [clearSpeechTimers]);

  const stopSpeaking = useCallback(() => {
    if (assistantTtsDebounceRef.current != null) {
      clearTimeout(assistantTtsDebounceRef.current);
      assistantTtsDebounceRef.current = null;
    }
    assistantSpeechRef.current = null;
    cancelPlayback();
    setIsSpeaking(false);
    setUsingAudioAnalysis(false);
  }, [cancelPlayback]);
  interruptSpeechRef.current = stopSpeaking;

  // ── ElevenLabs TTS ────────────────────────────────────────────────

  const speakElevenLabs = useCallback(
    async (
      text: string,
      elConfig: NonNullable<VoiceConfig["elevenlabs"]>,
      task: SpeakTask,
      generation: number,
    ) => {
      let ctx = sharedAudioCtx;
      if (!ctx) {
        ctx = new AudioContext();
        sharedAudioCtx = ctx;
      }
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          // Force a fresh context if resume fails
          ctx.close().catch((err: unknown) => {
            console.warn("[useVoiceChat] AudioContext.close() failed", err);
          });
          ctx = new AudioContext();
          sharedAudioCtx = ctx;
        }
      }

      const voiceId = elConfig.voiceId ?? DEFAULT_ELEVEN_VOICE;
      const modelId = elConfig.modelId ?? DEFAULT_ELEVEN_MODEL;

      const cacheKey =
        task.cacheKey ??
        (shouldCacheGeneratedSpeech(text, task.segment)
          ? makeElevenCacheKey(text, elConfig)
          : undefined);
      const cachedBytes = cacheKey ? globalAudioCache.get(cacheKey) : undefined;
      let audioBytes: Uint8Array | null = null;
      let cached = false;

      if (cacheKey && cachedBytes) {
        rememberCachedSegment(cacheKey, cachedBytes);
        audioBytes = cachedBytes.slice();
        cached = true;
      }

      if (!audioBytes) {
        const controller = new AbortController();
        activeFetchAbortRef.current = controller;

        const requestBody = {
          text,
          model_id: modelId,
          apply_text_normalization: "auto",
          voice_settings: {
            stability: elConfig.stability ?? 0.5,
            similarity_boost: elConfig.similarityBoost ?? 0.75,
            speed: elConfig.speed ?? 1.0,
          },
        };
        const apiToken = getElizaApiToken()?.trim() ?? "";
        const proxyRequestBody = JSON.stringify({
          ...requestBody,
          voiceId,
          modelId,
          outputFormat: "mp3_44100_128",
        });

        /**
         * Server-side TTS when the browser has no `xi-api-key`.
         * Always try Eliza Cloud (`/api/tts/cloud`) first — that is where a
         * persisted Eliza Cloud API key is used. `voiceMode` may still be
         * `own-key` when the UI has not yet marked cloud as connected (e.g.
         * disconnect preference, status poll race), which previously routed
         * here to `/api/tts/elevenlabs` only; The framework does not implement that
         * path, so chat fell back to browser (Edge) TTS. If cloud rejects
         * (no key), fall back to the upstream ElevenLabs proxy.
         */
        const makeProxyRequestInit = (): RequestInit => {
          const dbg = task.debugUtteranceContext;
          return {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
              ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
              ...(isTtsDebugEnabled() && dbg
                ? {
                    "x-elizaos-tts-message-id": encodeURIComponent(
                      dbg.messageId,
                    ),
                    "x-elizaos-tts-clip-segment": encodeURIComponent(
                      task.segment,
                    ),
                    "x-elizaos-tts-full-preview": encodeURIComponent(
                      dbg.fullAssistTextPreview,
                    ),
                  }
                : {}),
            },
            body: proxyRequestBody,
            signal: controller.signal,
          };
        };

        const shouldFallbackFromCloudProxy = (status: number): boolean =>
          status === 400 ||
          status === 401 ||
          status === 403 ||
          status === 404 ||
          status === 405 ||
          status === 501;

        const fetchViaBestAvailableProxy = async (): Promise<Response> => {
          const cloudTarget = resolveApiUrl("/api/tts/cloud");
          try {
            const cloudRes = await fetchWithCsrf(
              cloudTarget,
              makeProxyRequestInit(),
            );
            if (cloudRes.ok || !shouldFallbackFromCloudProxy(cloudRes.status)) {
              return cloudRes;
            }

            ttsDebug("useVoiceChat:cloud-proxy-fallback", {
              status: cloudRes.status,
              ttsTarget: describeTtsCloudFetchTargetForDebug(),
            });
          } catch (error) {
            ttsDebug("useVoiceChat:cloud-proxy-unavailable", {
              ttsTarget: describeTtsCloudFetchTargetForDebug(),
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return await fetchWithCsrf(
            resolveApiUrl("/api/tts/elevenlabs"),
            makeProxyRequestInit(),
          );
        };

        const trimmedApiKey =
          typeof elConfig.apiKey === "string" ? elConfig.apiKey.trim() : "";
        const hasDirectKey = hasConfiguredApiKey(trimmedApiKey);

        let res: Response;
        if (hasDirectKey) {
          try {
            const url = new URL(
              `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
            );
            url.searchParams.set("output_format", "mp3_44100_128");
            res = await fetch(url.toString(), {
              method: "POST",
              headers: {
                "xi-api-key": trimmedApiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });
          } catch {
            res = await fetchViaBestAvailableProxy();
          }

          // If the locally-available key is stale, fall back to server-side key.
          if (!res.ok && (res.status === 401 || res.status === 403)) {
            const proxyRes = await fetchViaBestAvailableProxy();
            if (proxyRes.ok) {
              res = proxyRes;
            }
          }
        } else {
          res = await fetchViaBestAvailableProxy();
        }

        if (activeFetchAbortRef.current === controller) {
          activeFetchAbortRef.current = null;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          ttsDebug("useVoiceChat:elevenlabs-http-error", {
            status: res.status,
            ttsTarget: describeTtsCloudFetchTargetForDebug(),
            hadBearer: Boolean(apiToken),
            bodyPreview: body.slice(0, 120),
          });
          throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
        }

        const audioData = await res.arrayBuffer();
        audioBytes = new Uint8Array(audioData);
        if (cacheKey) {
          rememberCachedSegment(cacheKey, audioBytes.slice());
        }
      }

      if (generation !== generationRef.current) return;
      const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(audioBytes));
      if (generation !== generationRef.current) return;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;
      timeDomainDataRef.current = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
      );

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioSourceRef.current = source;

      await new Promise<void>((resolve) => {
        let finished = false;
        const playStartMs = performance.now();
        let wrappedFinish: (() => void) | null = null;

        const finish = () => {
          if (finished) return;
          finished = true;
          if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) {
            activeTaskFinishRef.current = null;
          }
          if (audioSourceRef.current === source) {
            audioSourceRef.current = null;
          }
          source.onended = null;
          try {
            source.disconnect();
          } catch {
            /* ok */
          }
          try {
            analyser.disconnect();
          } catch {
            /* ok */
          }
          clearSpeechTimers();
          resolve();
        };

        wrappedFinish = () => {
          ttsDebug("play:web-audio:end", {
            segment: task.segment,
            elapsedMs: Math.round(performance.now() - playStartMs),
          });
          finish();
        };

        ttsDebug("play:web-audio:start", {
          segment: task.segment,
          append: task.append,
          cached,
          textChars: text.length,
          preview: ttsDebugTextPreview(text),
          durationSecApprox: Math.round(audioBuffer.duration * 100) / 100,
        });

        activeTaskFinishRef.current = wrappedFinish;
        source.onended = wrappedFinish;
        speechTimeoutRef.current = setTimeout(
          wrappedFinish,
          Math.max(2500, Math.ceil(audioBuffer.duration * 1000) + 1200),
        );

        source.start(0);
        emitPlaybackStart({
          text,
          segment: task.segment,
          provider: "elevenlabs",
          cached,
          startedAtMs: playStartMs,
          ...task.telemetry,
        });
      });
    },
    [clearSpeechTimers, makeElevenCacheKey, rememberCachedSegment],
  );

  // ── Local inference TTS ───────────────────────────────────────────────

  const speakLocalInference = useCallback(
    async (text: string, task: SpeakTask, generation: number) => {
      let ctx = sharedAudioCtx;
      if (!ctx) {
        ctx = new AudioContext();
        sharedAudioCtx = ctx;
      }
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          ctx.close().catch((err: unknown) => {
            console.warn("[useVoiceChat] AudioContext.close() failed", err);
          });
          ctx = new AudioContext();
          sharedAudioCtx = ctx;
        }
      }

      const cacheKey =
        task.cacheKey ??
        (shouldCacheGeneratedSpeech(text, task.segment)
          ? makeLocalInferenceCacheKey(text)
          : undefined);
      const cachedBytes = cacheKey ? globalAudioCache.get(cacheKey) : undefined;
      let audioBytes: Uint8Array | null = null;
      let cached = false;

      if (cacheKey && cachedBytes) {
        rememberCachedSegment(cacheKey, cachedBytes);
        audioBytes = cachedBytes.slice();
        cached = true;
      }

      if (!audioBytes) {
        const controller = new AbortController();
        activeFetchAbortRef.current = controller;
        let res: Response;
        try {
          res = await fetchWithCsrf(resolveApiUrl("/api/tts/local-inference"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/wav, audio/*;q=0.9",
            },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          });
        } finally {
          if (activeFetchAbortRef.current === controller) {
            activeFetchAbortRef.current = null;
          }
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `Local inference TTS ${res.status}: ${body.slice(0, 200)}`,
          );
        }

        audioBytes = new Uint8Array(await res.arrayBuffer());
        if (cacheKey) {
          rememberCachedSegment(cacheKey, audioBytes.slice());
        }
      }

      if (generation !== generationRef.current) return;
      const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(audioBytes));
      if (generation !== generationRef.current) return;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;
      timeDomainDataRef.current = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
      );

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioSourceRef.current = source;

      await new Promise<void>((resolve) => {
        let finished = false;
        const playStartMs = performance.now();
        let wrappedFinish: (() => void) | null = null;

        const finish = () => {
          if (finished) return;
          finished = true;
          if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) {
            activeTaskFinishRef.current = null;
          }
          if (audioSourceRef.current === source) {
            audioSourceRef.current = null;
          }
          source.onended = null;
          try {
            source.disconnect();
          } catch {
            /* ok */
          }
          try {
            analyser.disconnect();
          } catch {
            /* ok */
          }
          clearSpeechTimers();
          resolve();
        };

        wrappedFinish = finish;
        activeTaskFinishRef.current = wrappedFinish;
        source.onended = wrappedFinish;
        speechTimeoutRef.current = setTimeout(
          wrappedFinish,
          Math.max(2500, Math.ceil(audioBuffer.duration * 1000) + 1200),
        );

        source.start(0);
        emitPlaybackStart({
          text,
          segment: task.segment,
          provider: "local-inference",
          cached,
          startedAtMs: playStartMs,
          ...task.telemetry,
        });
      });
    },
    [clearSpeechTimers, makeLocalInferenceCacheKey, rememberCachedSegment],
  );

  // ── Browser SpeechSynthesis TTS ───────────────────────────────────

  const speakBrowser = useCallback(
    (text: string, task: SpeakTask, generation: number) => {
      const config = voiceConfigRef.current;
      const synth = synthRef.current;
      const requestedLocale = normalizeSpeechLocale(options.lang);
      const words = text.trim().split(/\s+/).length;
      const estimatedMs = Math.max(1200, (words / 3) * 1000);
      const useTalkModeTts = !synth && Boolean(getElectrobunRendererRpc());

      ttsDebug("speakBrowser:enter", {
        path: synth
          ? "speechSynthesis"
          : useTalkModeTts
            ? "talkmode-bridge"
            : "no-synth-timer-only",
        segment: task.segment,
        append: task.append,
        textChars: text.trim().length,
        preview: ttsDebugTextPreview(text),
        voiceConfigProvider: config?.provider ?? null,
        ...(config?.provider === "edge" && config.edge?.voice
          ? { edgeVoiceSetting: config.edge.voice }
          : {}),
      });

      return new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (activeTaskFinishRef.current === finish) {
            activeTaskFinishRef.current = null;
          }
          clearSpeechTimers();
          utteranceRef.current = null;
          resolve();
        };

        activeTaskFinishRef.current = finish;

        if (!synth) {
          if (getElectrobunRendererRpc()) {
            ttsDebug("play:talkmode:dispatch", {
              segment: task.segment,
              append: task.append,
              textChars: text.trim().length,
              preview: ttsDebugTextPreview(text),
              engine: "native-talkmode-bridge",
              note: "No window.speechSynthesis — routing TTS to main-process talkmodeSpeak",
            });
            void invokeDesktopBridgeRequest<void>({
              rpcMethod: "talkmodeSpeak",
              ipcChannel: "talkmode:speak",
              params: { text: text.trim() },
            }).catch((err: unknown) => {
              ttsDebug("play:talkmode:speak-failed", {
                segment: task.segment,
                preview: ttsDebugTextPreview(text),
                err:
                  err instanceof Error
                    ? `${err.name}: ${err.message.slice(0, 200)}`
                    : String(err).slice(0, 200),
              });
              console.warn("[useVoiceChat] Desktop speech bridge failed:", err);
            });
          } else {
            ttsDebug("play:browser:no-synth", {
              segment: task.segment,
              textChars: text.trim().length,
              preview: ttsDebugTextPreview(text),
              engine: "none",
              note: "No SpeechSynthesis — playback may be silent until Talk Mode or synth is available",
            });
          }
          emitPlaybackStart({
            text,
            segment: task.segment,
            provider: "browser",
            cached: false,
            startedAtMs: performance.now(),
            ...task.telemetry,
          });
          speechTimeoutRef.current = setTimeout(finish, estimatedMs);
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text.trim());
        utterance.lang = requestedLocale;
        utteranceRef.current = utterance;

        let selectedVoice: SpeechSynthesisVoice | undefined;
        if (synth?.getVoices) {
          const voices = synth.getVoices();

          if (config?.provider === "edge" && config.edge?.voice) {
            const edgeVoiceName = config.edge.voice;
            selectedVoice = voices.find(
              (v) => v.voiceURI === edgeVoiceName || v.name === edgeVoiceName,
            );

            if (!selectedVoice) {
              const isMale =
                edgeVoiceName.toLowerCase().includes("guy") ||
                edgeVoiceName.toLowerCase().includes("male");
              selectedVoice = voices.find((v) => {
                if (!matchesVoiceLocale(v, requestedLocale)) return false;
                const nameLower = v.name.toLowerCase();
                if (isMale) {
                  return (
                    nameLower.includes("male") ||
                    nameLower.includes("alex") ||
                    nameLower.includes("david") ||
                    nameLower.includes("daniel")
                  );
                } else {
                  return (
                    nameLower.includes("female") ||
                    nameLower.includes("samantha") ||
                    nameLower.includes("victoria") ||
                    nameLower.includes("zira") ||
                    nameLower.includes("karen")
                  );
                }
              });
            }
          }

          if (!selectedVoice) {
            if (localePrefix(requestedLocale) === "en") {
              selectedVoice =
                voices.find(
                  (v) =>
                    matchesVoiceLocale(v, requestedLocale) &&
                    !v.name.toLowerCase().includes("alex") &&
                    !v.name.toLowerCase().includes("david"),
                ) || voices.find((v) => matchesVoiceLocale(v, requestedLocale));
            } else {
              selectedVoice = voices.find((v) =>
                matchesVoiceLocale(v, requestedLocale),
              );
            }
          }

          if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang || requestedLocale;
          }
        }

        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        ttsDebug("play:browser:web-speech:enqueued", {
          segment: task.segment,
          append: task.append,
          textChars: text.trim().length,
          preview: ttsDebugTextPreview(text),
          requestedLocale,
          engine: "speechSynthesis",
          ...webSpeechVoiceDebugFields(selectedVoice),
        });

        const browserPlayStartMsRef = { value: 0 };
        utterance.onstart = () => {
          if (generation !== generationRef.current) return;
          browserPlayStartMsRef.value = performance.now();
          ttsDebug("play:browser:speechSynthesis:start", {
            segment: task.segment,
            append: task.append,
            textChars: text.trim().length,
            preview: ttsDebugTextPreview(text),
            requestedLocale,
            engine: "speechSynthesis-utterance-onstart",
            ...webSpeechVoiceDebugFields(selectedVoice),
          });
          emitPlaybackStart({
            text,
            segment: task.segment,
            provider: "browser",
            cached: false,
            startedAtMs: browserPlayStartMsRef.value,
            ...task.telemetry,
          });
        };
        const endBrowserUtterance = () => {
          if (browserPlayStartMsRef.value > 0) {
            ttsDebug("play:browser:speechSynthesis:end", {
              segment: task.segment,
              elapsedMs: Math.round(
                performance.now() - browserPlayStartMsRef.value,
              ),
            });
          }
          finish();
        };
        utterance.onend = endBrowserUtterance;
        utterance.onerror = (ev) => {
          const errEv = ev as SpeechSynthesisErrorEvent;
          ttsDebug("play:browser:speechSynthesis:error", {
            segment: task.segment,
            synthesisError: errEv.error ?? "unknown",
            preview: ttsDebugTextPreview(text),
            requestedLocale,
            ...webSpeechVoiceDebugFields(selectedVoice),
          });
          endBrowserUtterance();
        };
        synth.speak(utterance);

        speechTimeoutRef.current = setTimeout(finish, estimatedMs + 5000);
      });
    },
    [clearSpeechTimers, options.lang],
  );

  const processQueue = useCallback(() => {
    if (queueWorkerRunningRef.current) return;
    queueWorkerRunningRef.current = true;
    const workerGeneration = generationRef.current;

    void (async () => {
      try {
        while (queueRef.current.length > 0) {
          if (workerGeneration !== generationRef.current) break;
          const task = queueRef.current.shift();
          if (!task) break;

          const config = voiceConfigRef.current;
          const elConfig = config?.elevenlabs;
          const useElevenLabs = config?.provider === "elevenlabs";
          const useLocalInference = config?.provider === "local-inference";

          ttsDebug("processQueue:task", {
            useElevenLabs,
            useLocalInference,
            hasElConfig: Boolean(elConfig),
            segment: task.segment,
            append: task.append,
            textChars: task.text.length,
            preview: ttsDebugTextPreview(task.text),
            ...(task.debugUtteranceContext
              ? {
                  messageId: task.debugUtteranceContext.messageId,
                  hearingFull: task.debugUtteranceContext.fullAssistTextPreview,
                }
              : {}),
          });

          if (useLocalInference) {
            usingAudioAnalysisRef.current = true;
            setUsingAudioAnalysis(true);
            try {
              await speakLocalInference(task.text, task, workerGeneration);
              continue;
            } catch (error) {
              if (
                workerGeneration !== generationRef.current ||
                isAbortError(error)
              ) {
                break;
              }
              console.warn(
                "[useVoiceChat] Local inference TTS failed:",
                error instanceof Error ? `${error.name}: ${error.message}` : error,
              );
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
              throw error;
            }
          }

          if (useElevenLabs && elConfig) {
            usingAudioAnalysisRef.current = true;
            setUsingAudioAnalysis(true);
            try {
              await speakElevenLabs(
                task.text,
                elConfig,
                task,
                workerGeneration,
              );
              continue;
            } catch (error) {
              if (
                workerGeneration !== generationRef.current ||
                isAbortError(error)
              ) {
                break;
              }
              console.warn(
                "[useVoiceChat] ElevenLabs TTS failed:",
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : error,
              );
              ttsDebug("useVoiceChat:elevenlabs-failed", {
                err:
                  error instanceof Error
                    ? `${error.name}: ${error.message.slice(0, 200)}`
                    : String(error).slice(0, 200),
                ttsTarget: describeTtsCloudFetchTargetForDebug(),
                hadBearer: Boolean(getElizaApiToken()?.trim()),
              });
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
              throw error;
            }
          } else {
            usingAudioAnalysisRef.current = false;
            setUsingAudioAnalysis(false);
            ttsDebug("processQueue:browser-tts-direct", {
              reason: elConfig
                ? "provider_not_elevenlabs"
                : "missing_elevenlabs_config",
              provider: config?.provider ?? null,
              nextPath:
                "speakBrowser — OS Web Speech (often msedge/Microsoft) or Electrobun talkmode",
            });
          }

          await speakBrowser(task.text, task, workerGeneration);
        }
      } finally {
        queueWorkerRunningRef.current = false;
      }
      if (workerGeneration !== generationRef.current) return;
      if (queueRef.current.length > 0) {
        processQueue();
        return;
      }
      usingAudioAnalysisRef.current = false;
      setUsingAudioAnalysis(false);
      setIsSpeaking(false);
    })();
  }, [speakBrowser, speakElevenLabs, speakLocalInference]);

  const enqueueSpeech = useCallback(
    (task: SpeakTask) => {
      const speakable = toSpeakableText(task.text);
      if (!speakable) return;

      if (!task.append) {
        cancelPlayback();
      }

      queueRef.current.push({
        ...task,
        text: speakable,
        telemetry: task.telemetry
          ? {
              ...task.telemetry,
              queuedAtMs:
                typeof performance !== "undefined"
                  ? performance.now()
                  : Date.now(),
            }
          : undefined,
      });
      ttsDebug("enqueueSpeech", {
        segment: task.segment,
        append: task.append,
        textChars: speakable.length,
        preview: ttsDebugTextPreview(speakable),
        queueLen: queueRef.current.length,
      });
      speakingStartRef.current = Date.now();
      setIsSpeaking(true);
      processQueue();
    },
    [cancelPlayback, processQueue],
  );

  // ── Public speak APIs ─────────────────────────────────────────────

  const speak = useCallback(
    (text: string, speakOptions?: { append?: boolean }) => {
      if (assistantTtsDebounceRef.current != null) {
        clearTimeout(assistantTtsDebounceRef.current);
        assistantTtsDebounceRef.current = null;
      }
      assistantSpeechRef.current = null;
      enqueueSpeech({
        text,
        append: Boolean(speakOptions?.append),
        segment: "full",
      });
    },
    [enqueueSpeech],
  );

  const clearAssistantTtsDebounce = useCallback(() => {
    if (assistantTtsDebounceRef.current != null) {
      clearTimeout(assistantTtsDebounceRef.current);
      assistantTtsDebounceRef.current = null;
    }
  }, []);

  const flushPendingAssistantTts = useCallback(() => {
    assistantTtsDebounceRef.current = null;
    const state = assistantSpeechRef.current;
    if (!state || state.finalQueued) return;

    const latest = state.latestSpeakable;
    if (!latest) return;

    const unsent = remainderAfter(latest, state.queuedSpeakablePrefix);
    if (!unsent) return;

    const elConfig = voiceConfigRef.current?.elevenlabs;
    const isFirstClip = state.queuedSpeakablePrefix.length === 0;
    const segment = isFirstClip ? "full" : "remainder";
    const cacheKey =
      voiceConfigRef.current?.provider === "elevenlabs" &&
      elConfig &&
      shouldCacheGeneratedSpeech(unsent, segment)
        ? makeElevenCacheKey(unsent, elConfig)
        : undefined;

    const dbgUtterance = isTtsDebugEnabled()
      ? {
          messageId: state.messageId,
          fullAssistTextPreview: ttsDebugTextPreview(latest, 220),
        }
      : undefined;

    enqueueSpeech({
      text: unsent,
      append: !isFirstClip || !state.replacePlaybackOnFirstClip,
      segment,
      cacheKey,
      debugUtteranceContext: dbgUtterance,
      telemetry: state.telemetry,
    });

    state.queuedSpeakablePrefix = latest;
  }, [enqueueSpeech, makeElevenCacheKey]);

  const queueAssistantSpeech = useCallback(
    (
      messageId: string,
      text: string,
      isFinal: boolean,
      queueOptions?: QueueAssistantSpeechOptions,
    ) => {
      if (!messageId) return;

      const speakable = toSpeakableText(text);
      if (!speakable) {
        ttsDebug("queueAssistantSpeech:skip-empty", { messageId });
        return;
      }
      ttsDebug("queueAssistantSpeech", {
        messageId,
        isFinal,
        speakableChars: speakable.length,
        preview: ttsDebugTextPreview(speakable),
      });

      const current = assistantSpeechRef.current;
      if (!current || current.messageId !== messageId) {
        clearAssistantTtsDebounce();
        assistantSpeechRef.current = {
          messageId,
          queuedSpeakablePrefix: "",
          latestSpeakable: "",
          finalQueued: false,
          replacePlaybackOnFirstClip: queueOptions?.replace !== false,
          telemetry: queueOptions?.telemetry,
        };
      } else if (queueOptions?.telemetry) {
        current.telemetry = {
          ...current.telemetry,
          ...queueOptions.telemetry,
        };
      }

      const state = assistantSpeechRef.current;
      if (!state) return;

      state.latestSpeakable = speakable;

      if (ASSISTANT_TTS_FINAL_ONLY && !isFinal) {
        // Band-aid mode: never speak partial stream chunks.
        return;
      }

      if (ASSISTANT_TTS_FINAL_ONLY) {
        if (state.finalQueued) return;
        clearAssistantTtsDebounce();

        const elConfig = voiceConfigRef.current?.elevenlabs;
        const cacheKey =
          voiceConfigRef.current?.provider === "elevenlabs" &&
          elConfig &&
          shouldCacheGeneratedSpeech(speakable, "full")
            ? makeElevenCacheKey(speakable, elConfig)
            : undefined;
        const dbgUtterance = isTtsDebugEnabled()
          ? {
              messageId,
              fullAssistTextPreview: ttsDebugTextPreview(speakable, 220),
            }
          : undefined;

        // Final-only means one utterance per assistant message.
        enqueueSpeech({
          text: speakable,
          append: false,
          segment: "full",
          cacheKey,
          debugUtteranceContext: dbgUtterance,
          telemetry: state.telemetry,
        });
        state.queuedSpeakablePrefix = speakable;
        state.finalQueued = true;
        return;
      }

      if (
        speakable === state.queuedSpeakablePrefix &&
        (!isFinal || state.finalQueued)
      ) {
        return;
      }

      if (speakable === state.queuedSpeakablePrefix && isFinal) {
        clearAssistantTtsDebounce();
        state.finalQueued = true;
        return;
      }

      const unsent = remainderAfter(speakable, state.queuedSpeakablePrefix);
      if (!unsent) {
        if (isFinal) {
          clearAssistantTtsDebounce();
          state.finalQueued = true;
        }
        return;
      }

      const isFirstClip = state.queuedSpeakablePrefix.length === 0;
      const flushNow =
        isFinal ||
        (isFirstClip && unsent.length >= ASSISTANT_TTS_FIRST_FLUSH_CHARS) ||
        (!isFirstClip && unsent.length >= ASSISTANT_TTS_MIN_CHUNK_CHARS);

      if (flushNow) {
        clearAssistantTtsDebounce();
        const elConfig = voiceConfigRef.current?.elevenlabs;
        const segment = isFirstClip ? "full" : "remainder";
        const cacheKey =
          voiceConfigRef.current?.provider === "elevenlabs" &&
          elConfig &&
          shouldCacheGeneratedSpeech(unsent, segment)
            ? makeElevenCacheKey(unsent, elConfig)
            : undefined;
        const dbgUtterance = isTtsDebugEnabled()
          ? {
              messageId,
              fullAssistTextPreview: ttsDebugTextPreview(speakable, 220),
            }
          : undefined;
        enqueueSpeech({
          text: unsent,
          append: !isFirstClip || !state.replacePlaybackOnFirstClip,
          segment,
          cacheKey,
          debugUtteranceContext: dbgUtterance,
          telemetry: state.telemetry,
        });
        state.queuedSpeakablePrefix = speakable;
        if (isFinal) state.finalQueued = true;
        return;
      }

      clearAssistantTtsDebounce();
      assistantTtsDebounceRef.current = setTimeout(() => {
        flushPendingAssistantTts();
      }, ASSISTANT_TTS_DEBOUNCE_MS);
    },
    [
      clearAssistantTtsDebounce,
      enqueueSpeech,
      flushPendingAssistantTts,
      makeElevenCacheKey,
    ],
  );

  // ── Unlock audio on first user gesture ─────────────────────────────
  // Browsers block AudioContext and SpeechSynthesis until a user gesture.
  // On the first interaction we warm AudioContext (for ElevenLabs) and
  // bump voiceUnlockedGeneration so the auto-speak effect retries any
  // greeting that was silently dropped by autoplay policy.

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleUserGesture = () => {
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);

      // Warm AudioContext for ElevenLabs
      if (!sharedAudioCtx) {
        sharedAudioCtx = new AudioContext();
      }
      void sharedAudioCtx.resume().catch(() => {});

      // Signal that audio is now unlocked so callers can retry speech
      // that was silently blocked by browser autoplay policy.
      setVoiceUnlockedGeneration((g) => g + 1);
    };

    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
    };
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      void stopListening();
      void removeTalkModeListeners();
      stopSpeaking();
    };
  }, [removeTalkModeListeners, stopListening, stopSpeaking]);

  return {
    isListening,
    captureMode,
    isSpeaking,
    mouthOpen,
    interimTranscript,
    supported,
    usingAudioAnalysis,
    toggleListening,
    startListening,
    stopListening,
    speak,
    queueAssistantSpeech,
    stopSpeaking,
    voiceUnlockedGeneration,
    assistantTtsQuality,
  };
}
