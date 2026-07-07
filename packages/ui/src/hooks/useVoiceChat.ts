/**
 * Bidirectional voice hook for chat + avatar lip sync.
 *
 * TTS providers:
 *  - Eliza Cloud Kokoro through `/api/tts/cloud` for web/cloud defaults.
 *  - Local-inference Kokoro for provisioned local/native runtimes.
 *  - ElevenLabs for opt-in/custom voices.
 *  - Browser SpeechSynthesis only when it is the configured provider.
 *
 * STT: local-inference ASR on local desktop, then native TalkMode or browser
 * SpeechRecognition fallback.
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
import { APP_PAUSE_EVENT } from "../events";
import { resolveApiUrl } from "../utils";
import { getElizaApiToken } from "../utils/eliza-globals";
import {
  isTtsDebugEnabled,
  ttsDebug,
  ttsDebugTextPreview,
} from "../utils/tts-debug";
import { hasConfiguredApiKey } from "../voice";
import {
  isLocalAsrCaptureSupported,
  type LocalAsrRecorder,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import {
  isLocalInferenceAsrReady,
  transcribeCloudWav,
  transcribeLocalInferenceWav,
} from "../voice/local-asr-transcribe";
import {
  PlaybackFramePump,
  type PlaybackFrameTap,
} from "../voice/playback-frame-pump";
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
  type VoiceTtsError,
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

declare global {
  interface Window {
    /**
     * Headless-test observability flag — set true the first time a real TTS
     * playback starts. The voice self-test + real-audio e2e poll this to prove
     * audio flowed (the only honest "reply was spoken" signal in a headless
     * browser).
     */
    __voicePlaybackStarted?: boolean;
  }
}

// ── Shared mutable state ─────────────────────────────────────────────

let sharedAudioCtx: AudioContext | null = null;
const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 1200;
const CLOUD_TTS_TIMEOUT_MS = 60_000;
const LOCAL_INFERENCE_TTS_TIMEOUT_MS = 60_000;
/** How long the transient `micReconnected` pulse stays set after an auto-restart. */
const MIC_RECONNECT_PULSE_MS = 1500;

// ── Internal helpers ─────────────────────────────────────────────────

async function resumeAudioContextForPlayback(
  ctx: AudioContext,
  timeoutMs = AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
): Promise<boolean> {
  if (ctx.state !== "suspended") return true;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const resumed = await Promise.race([
      ctx.resume().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return resumed && ctx.state !== "suspended";
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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

function shouldUseLocalInferenceAsr(config: VoiceConfig | null): boolean {
  return config?.asr?.provider === "local-inference";
}

/**
 * True when the config selects a cloud STT provider (`eliza-cloud` / `openai`).
 * These capture the same WAV as the local path and POST it to `/api/asr/cloud`
 * (the agent's cloud STT proxy) — the deterministic cloud transcriber, NOT the
 * engine-dependent browser recognizer. Without this branch a `eliza-cloud`
 * config silently fell through to browser SpeechRecognition, which is the wrong
 * transcriber (and unreliable / absent on iOS PWA).
 */
function shouldUseCloudAsr(config: VoiceConfig | null): boolean {
  const provider = config?.asr?.provider;
  return provider === "eliza-cloud" || provider === "openai";
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
  shouldUseLocalInferenceAsr,
  resumeAudioContextForPlayback,
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
  // True when a TTS clip was blocked because the AudioContext is still
  // suspended (browser autoplay policy). Callers surface an "tap to enable
  // sound" hint. Cleared on the next user-gesture unlock.
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  // Transient pulse: set when browser SpeechRecognition silently auto-restarts
  // (the engine ends a segment mid-session and we restart it). Lets callers
  // flash a brief "reconnected" indicator instead of the restart being silent.
  const [micReconnected, setMicReconnected] = useState(false);
  const micReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Set when the configured TTS engine fails and the queue is stopped WITHOUT
  // substituting a different voice (#12253). The voice UI renders this as a
  // toast/banner; cleared on the next enqueue/stop.
  const [ttsError, setTtsError] = useState<VoiceTtsError | null>(null);

  // Refs — stable across renders, read from animation loop & callbacks
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const localAsrRecorderRef = useRef<LocalAsrRecorder | null>(null);
  const sttBackendRef = useRef<
    "browser" | "local-inference" | "cloud" | "talkmode" | null
  >(null);
  const talkModeHandlesRef = useRef<PluginListenerHandle[]>([]);
  // In-flight talk-mode listener registration. talkModeHandlesRef is only
  // assigned after all three addListener awaits resolve, so two overlapping
  // ensureTalkModeListeners calls would otherwise both pass the length guard
  // and register six listeners (the first three leaked, transcripts doubled).
  const talkModeListenersRegistrationRef = useRef<Promise<void> | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playbackFrameTapRef = useRef<PlaybackFrameTap | null>(null);
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
    // Headless-test observability: a real TTS playback actually started. The
    // voice self-test + real-audio e2e poll this to prove audio flowed (the
    // only honest "reply was spoken" signal in a headless browser).
    if (typeof window !== "undefined") {
      window.__voicePlaybackStarted = true;
    }
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
  const playbackFramePumpRef = useRef<PlaybackFramePump | null>(null);

  const getPlaybackFramePump = useCallback(() => {
    if (!playbackFramePumpRef.current) {
      playbackFramePumpRef.current = new PlaybackFramePump();
    }
    return playbackFramePumpRef.current;
  }, []);

  const stopPlaybackFrameTap = useCallback(
    (options: { reset?: boolean; drain?: boolean } = {}) => {
      const tap = playbackFrameTapRef.current;
      playbackFrameTapRef.current = null;
      if (!tap) return;
      void tap.stop(options).catch(() => {
        /* best effort only */
      });
    },
    [],
  );

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

  // Playback was rejected because the AudioContext is still suspended (autoplay
  // policy). Raise the unlock hint so a caller can prompt for a user gesture.
  const markAudioBlocked = useCallback(() => {
    setNeedsAudioUnlock(true);
  }, []);
  // A clip played (or the context was already running). Any prior unlock hint is
  // stale, so clear it.
  const markAudioPlaying = useCallback(() => {
    setNeedsAudioUnlock(false);
  }, []);
  // Explicitly unlock audio playback in response to a user gesture (e.g. the
  // status-bar "enable sound" button). Warms/resumes the shared AudioContext,
  // bumps the unlock generation so a blocked greeting retries, and clears the
  // hint. The passive first-gesture listener covers the common case; this covers
  // a context that re-suspended after the initial unlock (tab switch, etc.).
  const unlockAudio = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContext({ latencyHint: "interactive" });
    }
    // error-policy:J5 unhandled-rejection guard; resume() may reject on a context
    // that re-suspended, but the unlock generation bump below still re-arms audio
    // and the real playback path surfaces any persistent failure.
    void sharedAudioCtx.resume().catch(() => {});
    setVoiceUnlockedGeneration((g) => g + 1);
    setNeedsAudioUnlock(false);
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

  const makeElizaCloudCacheKey = useCallback(
    (text: string) => ["eliza-cloud", normalizeCacheText(text)].join("|"),
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
      const localAsrSupported =
        shouldUseLocalInferenceAsr(voiceConfigRef.current) &&
        isLocalAsrCaptureSupported();
      if (localAsrSupported) {
        if (!cancelled) {
          setSupported(true);
        }
        return;
      }
      // Cloud STT (`eliza-cloud` / `openai`) records the same WAV as the local
      // path, so voice is supported whenever WAV capture primitives exist —
      // independent of the browser SpeechRecognition engine (absent on iOS PWA).
      const cloudAsrSupported =
        shouldUseCloudAsr(voiceConfigRef.current) &&
        isLocalAsrCaptureSupported();
      if (cloudAsrSupported) {
        if (!cancelled) {
          setSupported(true);
        }
        return;
      }
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

      if (isFinal && mode === "passive") {
        emitTranscript(nextText, {
          text: nextText,
          mode,
          isFinal: true,
          turn,
          speaker: turn.speaker,
        });
        transcriptBufferRef.current = "";
        latestTranscriptTurnRef.current = null;
        setInterimTranscript("");
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
    localAsrRecorderRef.current = null;
    sttBackendRef.current = null;
    enabledRef.current = false;
    listeningModeRef.current = "idle";
    setIsListening(false);
    setCaptureMode("idle");
    setInterimTranscript("");
  }, []);

  // Discard the composer's in-flight capture on app suspend WITHOUT transcribing
  // (#voice-V1). iOS suspends the WebAudio graph when the PWA backgrounds: the
  // WAV recorder's `ScriptProcessorNode` stalls, so `stop()` would POST a
  // truncated/empty WAV (a doomed STT round-trip) and throw "No microphone audio
  // was captured". `recorder.cancel()` releases the getUserMedia MediaStream
  // tracks (so iOS drops the mic indicator during suspension) and closes the
  // AudioContext without a transcribe; the browser recognizer is aborted the
  // same way. `resetListeningState` clears the stuck "listening" UI so the next
  // gesture re-arms from a clean idle instead of early-returning against a stale
  // recorder ref. The composer mic is push-to-talk (gesture-driven), not
  // hands-free, so there is nothing to auto-re-arm on resume — the user's next
  // press starts a fresh capture.
  const discardCaptureForSuspend = useCallback(() => {
    if (listeningModeRef.current === "idle" && !localAsrRecorderRef.current) {
      return;
    }
    enabledRef.current = false;
    const recorder = localAsrRecorderRef.current;
    localAsrRecorderRef.current = null;
    if (recorder) {
      // cancel() releases the mic tracks + closes the context, no throw, no POST.
      recorder.cancel();
    }
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    }
    // Native TalkMode owns its own mic session; ask it to stop so iOS doesn't
    // hold the recognizer open across suspension. Best-effort — a stopped
    // recognizer no-ops.
    if (sttBackendRef.current === "talkmode") {
      void getTalkModePlugin()
        .stop()
        .catch(() => {
          /* ignore */
        });
    }
    resetListeningState();
  }, [resetListeningState]);

  const ensureTalkModeListeners = useCallback(async () => {
    if (talkModeHandlesRef.current.length > 0) return;
    // A registration pass is already in flight — await it instead of starting
    // a second one (which would double-register every listener).
    const pending = talkModeListenersRegistrationRef.current;
    if (pending) return pending;

    const registration = (async () => {
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
          applyTranscriptUpdate(
            event.transcript ?? "",
            event.isFinal === true,
            {
              mode:
                normalizeActiveVoiceSessionMode(typedEvent.mode) ?? undefined,
              speaker: typedEvent.speaker,
              source: typedEvent.source,
              confidence: typedEvent.confidence,
              turn: typedEvent.turn,
              metadata: typedEvent.metadata,
            },
          );
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
    })();
    // Stored synchronously (before the first await inside the registration
    // yields) so a concurrent caller reuses this pass instead of re-adding.
    talkModeListenersRegistrationRef.current = registration;
    try {
      await registration;
    } finally {
      talkModeListenersRegistrationRef.current = null;
    }
  }, [applyTranscriptUpdate, resetListeningState]);

  const transcribeLocalInferenceAudio = useCallback(
    async (audio: Uint8Array, signal?: AbortSignal): Promise<string> => {
      const { text } = await transcribeLocalInferenceWav(audio, { signal });
      return text;
    },
    [],
  );

  const transcribeCloudAudio = useCallback(
    async (audio: Uint8Array, signal?: AbortSignal): Promise<string> => {
      return transcribeCloudWav(audio, { signal });
    },
    [],
  );

  const startLocalInferenceRecognition = useCallback(
    async (mode: Exclude<VoiceCaptureMode, "idle">) => {
      if (!shouldUseLocalInferenceAsr(voiceConfigRef.current)) {
        return false;
      }
      if (!isLocalAsrCaptureSupported()) {
        return false;
      }
      // Defer to the next backend (talk-mode / browser) when the server can't
      // transcribe right now — capturing here would only 502 at stop() with no
      // recoverable fallback (no local ASR assets / native adapter installed).
      if (!(await isLocalInferenceAsrReady())) {
        return false;
      }

      try {
        const recorder = await startLocalAsrRecorder();
        localAsrRecorderRef.current = recorder;
        sttBackendRef.current = "local-inference";
        enabledRef.current = true;
        listeningModeRef.current = mode;
        setSupported(true);
        setCaptureMode(mode);
        setIsListening(true);
        return true;
      } catch {
        localAsrRecorderRef.current = null;
        return false;
      }
    },
    [],
  );

  // Cloud STT: capture the SAME mono PCM16 WAV as the local-inference path and
  // POST it to `/api/asr/cloud` on stop (see stopListening). This is the real
  // transcriber for the `eliza-cloud` / `openai` config default — the browser
  // recognizer is engine-dependent (and unreliable/absent on iOS PWA), so a
  // cloud config must not fall through to it. Reuses `localAsrRecorderRef` for
  // the mic recorder; `sttBackendRef` = "cloud" routes the stop-time transcribe.
  const startCloudRecognition = useCallback(
    async (mode: Exclude<VoiceCaptureMode, "idle">) => {
      if (!shouldUseCloudAsr(voiceConfigRef.current)) {
        return false;
      }
      // No WAV capture primitives (no getUserMedia / AudioContext) → there is no
      // WAV to POST; defer to the browser recognizer as the sole client option.
      if (!isLocalAsrCaptureSupported()) {
        return false;
      }
      try {
        const recorder = await startLocalAsrRecorder();
        localAsrRecorderRef.current = recorder;
        sttBackendRef.current = "cloud";
        enabledRef.current = true;
        listeningModeRef.current = mode;
        setSupported(true);
        setCaptureMode(mode);
        setIsListening(true);
        return true;
      } catch {
        localAsrRecorderRef.current = null;
        return false;
      }
    },
    [],
  );

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
            // Surface the silent restart as a brief pulse so the UI can show a
            // "mic reconnected" indicator instead of an unexplained gap.
            setMicReconnected(true);
            if (micReconnectTimerRef.current !== null) {
              clearTimeout(micReconnectTimerRef.current);
            }
            micReconnectTimerRef.current = setTimeout(() => {
              micReconnectTimerRef.current = null;
              setMicReconnected(false);
            }, MIC_RECONNECT_PULSE_MS);
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

      try {
        await ensureTalkModeListeners();
        const talkMode = getTalkModePlugin();
        const browserSpeechSupported = !!getSpeechRecognitionCtor();
        // error-policy:J4 designed degrade — a failed permission probe reads as
        // null and is treated as "maybe supported", deferring the real decision
        // to the actual speech attempt rather than falsely disabling voice.
        let permissions = await talkMode.checkPermissions().catch(() => null);
        const nativeSpeechSupported =
          permissions?.speechRecognition !== "not_supported";
        if (!nativeSpeechSupported && !browserSpeechSupported) {
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
              ...(directRpc ? { engine: "web" as const } : {}),
              language: options.lang ?? "en-US",
              modelSize: "base",
              sampleRate: 16000,
            },
            silenceWindowMs: 350,
            interruptOnSpeech: true,
          },
        });
        if (!result.started) {
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
      } catch {
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

      const localStarted = await startLocalInferenceRecognition(mode);
      if (localStarted) {
        return;
      }

      // Cloud STT (`eliza-cloud` / `openai`): the deterministic transcriber for
      // that config default. Selected ahead of talk-mode/browser so a cloud
      // config on the PWA records a WAV for `/api/asr/cloud` instead of falling
      // through to the engine-dependent browser recognizer.
      const cloudStarted = await startCloudRecognition(mode);
      if (cloudStarted) {
        return;
      }

      if (shouldPreferNativeTalkMode()) {
        const started = await startTalkModeRecognition(mode);
        if (started) {
          return;
        }
      }

      startBrowserRecognition(mode);
    },
    [
      startBrowserRecognition,
      startCloudRecognition,
      startLocalInferenceRecognition,
      startTalkModeRecognition,
    ],
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
      } else if (sttBackendRef.current === "local-inference") {
        const recorder = localAsrRecorderRef.current;
        localAsrRecorderRef.current = null;
        if (recorder) {
          try {
            const audio = await recorder.stop();
            const transcript = await transcribeLocalInferenceAudio(audio);
            applyTranscriptUpdate(transcript, true, {
              mode:
                normalizeActiveVoiceSessionMode(mode) ??
                normalizeActiveVoiceSessionMode(listeningModeRef.current) ??
                "compose",
              source: "local-inference",
              metadata: { source: "local-inference" },
            });
          } catch (error) {
            ttsDebug("asr:local-inference:error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else if (sttBackendRef.current === "cloud") {
        // Symmetric with local-inference: stop the recorder, POST the WAV to
        // `/api/asr/cloud`, and apply the returned transcript. A cloud failure
        // is logged (fail-loud, no silent downgrade to browser STT) so the turn
        // just doesn't submit rather than being transcribed by the wrong engine.
        const recorder = localAsrRecorderRef.current;
        localAsrRecorderRef.current = null;
        if (recorder) {
          try {
            const audio = await recorder.stop();
            const transcript = await transcribeCloudAudio(audio);
            applyTranscriptUpdate(transcript, true, {
              mode:
                normalizeActiveVoiceSessionMode(mode) ??
                normalizeActiveVoiceSessionMode(listeningModeRef.current) ??
                "compose",
              source: "cloud",
              metadata: { source: "cloud" },
            });
          } catch (error) {
            ttsDebug("asr:cloud:error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else {
        recognitionRef.current?.stop();
        await new Promise((resolve) =>
          window.setTimeout(resolve, TALKMODE_STOP_SETTLE_MS),
        );
      }

      finalizeRecognition(submit);
    },
    [
      applyTranscriptUpdate,
      finalizeRecognition,
      transcribeCloudAudio,
      transcribeLocalInferenceAudio,
    ],
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
    stopPlaybackFrameTap({ reset: true, drain: false });

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

    // Native TalkMode TTS — interrupt any in-flight native speak so barge-in
    // actually silences the agent. Without this the awaited TalkMode.speak()
    // plays to completion and the agent talks over the user.
    if (Capacitor.isNativePlatform()) {
      // error-policy:J6 best-effort interrupt/teardown of in-flight native speak
      // for barge-in; if the stop fails there is no further recourse here.
      void getTalkModePlugin()
        .stopSpeaking?.()
        .catch(() => {});
    }

    clearSpeechTimers();
    usingAudioAnalysisRef.current = false;
    setUsingAudioAnalysis(false);
  }, [clearSpeechTimers, stopPlaybackFrameTap]);

  const stopSpeaking = useCallback(() => {
    if (assistantTtsDebounceRef.current != null) {
      clearTimeout(assistantTtsDebounceRef.current);
      assistantTtsDebounceRef.current = null;
    }
    assistantSpeechRef.current = null;
    cancelPlayback();
    setIsSpeaking(false);
    setUsingAudioAnalysis(false);
    setTtsError(null);
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
        ctx = new AudioContext({ latencyHint: "interactive" });
        sharedAudioCtx = ctx;
      }
      if (ctx.state === "suspended") {
        const resumed = await resumeAudioContextForPlayback(ctx);
        if (!resumed) {
          ttsDebug("play:audio-context-blocked", {
            provider: "elevenlabs",
            state: ctx.state,
          });
          markAudioBlocked();
          throw new DOMException(
            "Audio playback is blocked until a user gesture unlocks the audio context",
            "NotAllowedError",
          );
        }
      }
      markAudioPlaying();

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

            // Same-engine transport fallback (cloud proxy → direct ElevenLabs
            // proxy): still ElevenLabs, same voice — NOT a voice swap (#12253).
            // Log at warn (not debug-only) so the retry is visible in the
            // console without the TTS debug flag.
            console.warn(
              `[useVoiceChat] Cloud TTS proxy returned ${cloudRes.status}; retrying via the direct ElevenLabs proxy (same voice)`,
            );
            ttsDebug("useVoiceChat:cloud-proxy-fallback", {
              status: cloudRes.status,
              ttsTarget: describeTtsCloudFetchTargetForDebug(),
            });
          } catch (error) {
            console.warn(
              `[useVoiceChat] Cloud TTS proxy unreachable; retrying via the direct ElevenLabs proxy (same voice): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            ttsDebug("useVoiceChat:cloud-proxy-unavailable", {
              ttsTarget: describeTtsCloudFetchTargetForDebug(),
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return fetchWithCsrf(
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
      // error-policy:J6 best-effort visualizer tap; if attaching the frame pump
      // fails, audio still plays — the tap only drives the waveform decoration.
      const playbackTap = await getPlaybackFramePump()
        .tapSource(ctx, source, audioBuffer)
        .catch(() => null);

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
          if (playbackFrameTapRef.current === playbackTap) {
            playbackFrameTapRef.current = null;
          }
          void playbackTap?.stop({ reset: true }).catch(() => {
            /* best effort only */
          });
          source.onended = null;
          try {
            source.disconnect();
          } catch (error) {
            // error-policy:J6 best-effort WebAudio teardown; disconnect can throw after playback has already ended.
            ttsDebug("play:eliza-cloud:source-disconnect-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            analyser.disconnect();
          } catch (error) {
            // error-policy:J6 best-effort WebAudio teardown; disconnect can throw after playback has already ended.
            ttsDebug("play:eliza-cloud:analyser-disconnect-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
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
        if (playbackTap) {
          playbackFrameTapRef.current = playbackTap;
          playbackTap.start(playStartMs);
        }
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
    [
      clearSpeechTimers,
      getPlaybackFramePump,
      makeElevenCacheKey,
      markAudioBlocked,
      markAudioPlaying,
      rememberCachedSegment,
    ],
  );

  // ── Eliza Cloud Kokoro TTS ─────────────────────────────────────────────

  const speakElizaCloud = useCallback(
    async (text: string, task: SpeakTask, generation: number) => {
      let ctx = sharedAudioCtx;
      if (!ctx) {
        ctx = new AudioContext({ latencyHint: "interactive" });
        sharedAudioCtx = ctx;
      }
      if (ctx.state === "suspended") {
        const resumed = await resumeAudioContextForPlayback(ctx);
        if (!resumed) {
          ttsDebug("play:audio-context-blocked", {
            provider: "eliza-cloud",
            state: ctx.state,
          });
          markAudioBlocked();
          throw new DOMException(
            "Audio playback is blocked until a user gesture unlocks the audio context",
            "NotAllowedError",
          );
        }
      }
      markAudioPlaying();

      const cacheKey =
        task.cacheKey ??
        (shouldCacheGeneratedSpeech(text, task.segment)
          ? makeElizaCloudCacheKey(text)
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
        const timeoutId = setTimeout(() => {
          controller.abort(
            new DOMException("Eliza Cloud TTS timed out", "TimeoutError"),
          );
        }, CLOUD_TTS_TIMEOUT_MS);
        let res: Response;
        try {
          const apiToken = getElizaApiToken()?.trim() ?? "";
          const dbg = task.debugUtteranceContext;
          res = await fetchWithCsrf(resolveApiUrl("/api/tts/cloud"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/wav, audio/mpeg, audio/*;q=0.9",
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
            body: JSON.stringify({ text }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
          if (activeFetchAbortRef.current === controller) {
            activeFetchAbortRef.current = null;
          }
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          ttsDebug("useVoiceChat:eliza-cloud-http-error", {
            status: res.status,
            ttsTarget: describeTtsCloudFetchTargetForDebug(),
            hadBearer: Boolean(getElizaApiToken()?.trim()),
            bodyPreview: body.slice(0, 120),
          });
          throw new Error(
            `Eliza Cloud TTS ${res.status}: ${body.slice(0, 200)}`,
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
      // error-policy:J6 best-effort visualizer tap; if attaching the frame pump
      // fails, audio still plays — the tap only drives the waveform decoration.
      const playbackTap = await getPlaybackFramePump()
        .tapSource(ctx, source, audioBuffer)
        .catch(() => null);

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
          if (playbackFrameTapRef.current === playbackTap) {
            playbackFrameTapRef.current = null;
          }
          void playbackTap?.stop({ reset: true }).catch(() => {
            /* best effort only */
          });
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
        if (playbackTap) {
          playbackFrameTapRef.current = playbackTap;
          playbackTap.start(playStartMs);
        }
        speechTimeoutRef.current = setTimeout(
          wrappedFinish,
          Math.max(2500, Math.ceil(audioBuffer.duration * 1000) + 1200),
        );

        source.start(0);
        emitPlaybackStart({
          text,
          segment: task.segment,
          provider: "eliza-cloud",
          cached,
          startedAtMs: playStartMs,
          ...task.telemetry,
        });
      });
    },
    [
      clearSpeechTimers,
      getPlaybackFramePump,
      makeElizaCloudCacheKey,
      markAudioBlocked,
      markAudioPlaying,
      rememberCachedSegment,
    ],
  );

  // ── Local inference TTS ───────────────────────────────────────────────

  const speakLocalInference = useCallback(
    async (text: string, task: SpeakTask, generation: number) => {
      let ctx = sharedAudioCtx;
      if (!ctx) {
        ctx = new AudioContext({ latencyHint: "interactive" });
        sharedAudioCtx = ctx;
      }
      if (ctx.state === "suspended") {
        const resumed = await resumeAudioContextForPlayback(ctx);
        if (!resumed) {
          ttsDebug("play:audio-context-blocked", {
            provider: "local-inference",
            state: ctx.state,
          });
          markAudioBlocked();
          throw new DOMException(
            "Audio playback is blocked until a user gesture unlocks the audio context",
            "NotAllowedError",
          );
        }
      }
      markAudioPlaying();

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
        const timeoutId = setTimeout(() => {
          controller.abort(
            new DOMException("Local inference TTS timed out", "TimeoutError"),
          );
        }, LOCAL_INFERENCE_TTS_TIMEOUT_MS);
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
          clearTimeout(timeoutId);
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
      // error-policy:J6 best-effort visualizer tap; if attaching the frame pump
      // fails, audio still plays — the tap only drives the waveform decoration.
      const playbackTap = await getPlaybackFramePump()
        .tapSource(ctx, source, audioBuffer)
        .catch(() => null);

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
          if (playbackFrameTapRef.current === playbackTap) {
            playbackFrameTapRef.current = null;
          }
          void playbackTap?.stop({ reset: true }).catch(() => {
            /* best effort only */
          });
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
        if (playbackTap) {
          playbackFrameTapRef.current = playbackTap;
          playbackTap.start(playStartMs);
        }
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
    [
      clearSpeechTimers,
      getPlaybackFramePump,
      makeLocalInferenceCacheKey,
      markAudioBlocked,
      markAudioPlaying,
      rememberCachedSegment,
    ],
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
            : "no-synth",
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
          if (!getElectrobunRendererRpc()) {
            ttsDebug("play:browser:no-synth", {
              segment: task.segment,
              textChars: text.trim().length,
              preview: ttsDebugTextPreview(text),
              engine: "none",
              note: "No SpeechSynthesis or Talk Mode bridge; no playback emitted",
            });
            finish();
            return;
          }

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
          });
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
                    nameLower.includes("sam") ||
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
      let workerError: unknown = null;
      // Set alongside `workerError` at a fail-closed site so the tail can raise
      // a user-visible error state instead of silently swapping voices (#12253).
      let ttsFailure: VoiceTtsError | null = null;
      const failClosed = (
        engine: VoiceTtsError["engine"],
        error: unknown,
      ): void => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[useVoiceChat] ${engine} TTS failed; failing closed (no voice-engine swap): ${message}`,
        );
        workerError = error;
        ttsFailure = {
          engine,
          message,
          atMs:
            typeof performance !== "undefined" ? performance.now() : Date.now(),
        };
        queueRef.current = [];
      };
      try {
        while (queueRef.current.length > 0) {
          if (workerGeneration !== generationRef.current) break;
          const task = queueRef.current.shift();
          if (!task) break;

          const config = voiceConfigRef.current;
          const elConfig = config?.elevenlabs;
          const useElizaCloud = config?.provider === "eliza-cloud";
          const useElevenLabs = config?.provider === "elevenlabs";
          const useLocalInference = config?.provider === "local-inference";

          ttsDebug("processQueue:task", {
            useElizaCloud,
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

          // Native mobile (Android/iOS Capacitor): route the reply through the
          // native TalkMode engine (Kotlin AudioTrack / on-device local-inference
          // TTS) per the Android TTS-owner decision, instead of the WebView
          // AudioContext path. Native errors fail closed below so the configured
          // voice is not silently swapped for a different engine.
          if (Capacitor.isNativePlatform()) {
            const trimmed = task.text.trim();
            if (!trimmed) continue;
            usingAudioAnalysisRef.current = false;
            setUsingAudioAnalysis(false);
            emitPlaybackStart({
              text: task.text,
              segment: task.segment,
              provider: "browser",
              cached: false,
              startedAtMs: performance.now(),
              ...task.telemetry,
            });
            try {
              const result = await getTalkModePlugin().speak({
                text: trimmed,
                useLocalInferenceTts: true,
              });
              if (workerGeneration !== generationRef.current) break;
              if (result?.error) throw new Error(result.error);
              continue;
            } catch (error) {
              if (
                workerGeneration !== generationRef.current ||
                isAbortError(error)
              ) {
                break;
              }
              // FAIL CLOSED (#12253): the native talkmode engine is the
              // configured voice. Do not fall through to the web TTS chain
              // (a different voice) — stop the queue and surface the error.
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
              ttsDebug("useVoiceChat:native-talkmode-failed", {
                err:
                  error instanceof Error
                    ? `${error.name}: ${error.message.slice(0, 200)}`
                    : String(error).slice(0, 200),
              });
              failClosed("native-talkmode", error);
              break;
            }
          }

          if (useElizaCloud) {
            usingAudioAnalysisRef.current = true;
            setUsingAudioAnalysis(true);
            try {
              await speakElizaCloud(task.text, task, workerGeneration);
              continue;
            } catch (error) {
              if (
                workerGeneration !== generationRef.current ||
                isAbortError(error)
              ) {
                break;
              }
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
              ttsDebug("useVoiceChat:eliza-cloud-failed", {
                err:
                  error instanceof Error
                    ? `${error.name}: ${error.message.slice(0, 200)}`
                    : String(error).slice(0, 200),
                ttsTarget: describeTtsCloudFetchTargetForDebug(),
                hadBearer: Boolean(getElizaApiToken()?.trim()),
              });
              // FAIL CLOSED (#12253): Eliza Cloud Kokoro is the configured
              // voice. Do not silently swap to browser SpeechSynthesis — stop
              // the queue and surface the error so users see why they heard
              // silence.
              failClosed("eliza-cloud", error);
              break;
            }
          }

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
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
              ttsDebug("useVoiceChat:local-inference-failed", {
                err:
                  error instanceof Error
                    ? `${error.name}: ${error.message.slice(0, 200)}`
                    : String(error).slice(0, 200),
              });
              // FAIL CLOSED (#12253): local-inference (Kokoro) is the configured
              // voice. Do not silently swap to browser SpeechSynthesis — stop the
              // queue and surface the error so the user hears silence + sees why,
              // not a stranger's voice.
              failClosed("local-inference", error);
              break;
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
              // FAIL CLOSED (#12253): ElevenLabs is the explicitly configured
              // voice here (provider === "elevenlabs"). Do not silently swap to
              // browser SpeechSynthesis — stop the queue and surface the error.
              // (Same-engine transport retries live inside speakElevenLabs: the
              // cloud proxy → /api/tts/elevenlabs retry is ElevenLabs→ElevenLabs,
              // not a voice swap.)
              failClosed("elevenlabs", error);
              break;
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
      } catch (error) {
        workerError = error;
        queueRef.current = [];
        ttsDebug("processQueue:error", {
          err:
            error instanceof Error
              ? `${error.name}: ${error.message.slice(0, 200)}`
              : String(error).slice(0, 200),
        });
      } finally {
        queueWorkerRunningRef.current = false;
      }
      if (workerGeneration !== generationRef.current) {
        if (queueRef.current.length > 0) {
          processQueue();
        }
        return;
      }
      if (workerError) {
        usingAudioAnalysisRef.current = false;
        setUsingAudioAnalysis(false);
        setIsSpeaking(false);
        // Raise a user-visible error only when a configured engine failed
        // closed (#12253); the generic catch above leaves ttsFailure null.
        if (ttsFailure) {
          setTtsError(ttsFailure);
        }
        return;
      }
      if (queueRef.current.length > 0) {
        processQueue();
        return;
      }
      usingAudioAnalysisRef.current = false;
      setUsingAudioAnalysis(false);
      setIsSpeaking(false);
    })();
  }, [speakBrowser, speakElevenLabs, speakElizaCloud, speakLocalInference]);

  const enqueueSpeech = useCallback(
    (task: SpeakTask) => {
      const speakable = toSpeakableText(task.text);
      if (!speakable) return;

      // A new utterance clears any prior fail-closed TTS error banner (#12253).
      setTtsError(null);

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

      const boundaryPrefix = queueableSpeechPrefix(speakable, isFinal);
      const boundaryUnsent = boundaryPrefix
        ? remainderAfter(boundaryPrefix, state.queuedSpeakablePrefix)
        : "";
      const rawUnsent = remainderAfter(speakable, state.queuedSpeakablePrefix);
      if (!rawUnsent) {
        if (isFinal) {
          clearAssistantTtsDebounce();
          state.finalQueued = true;
        }
        return;
      }

      const isFirstClip = state.queuedSpeakablePrefix.length === 0;
      const thresholdFlush =
        isFinal ||
        (isFirstClip && rawUnsent.length >= ASSISTANT_TTS_FIRST_FLUSH_CHARS) ||
        (!isFirstClip && rawUnsent.length >= ASSISTANT_TTS_MIN_CHUNK_CHARS);
      const targetPrefix = boundaryUnsent
        ? boundaryPrefix
        : thresholdFlush
          ? speakable
          : "";
      const unsent = targetPrefix
        ? remainderAfter(targetPrefix, state.queuedSpeakablePrefix)
        : "";
      const flushNow = Boolean(unsent);

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
        state.queuedSpeakablePrefix = targetPrefix;
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
      // Warm/resume the context and clear any stale unlock hint. Shared with the
      // explicit `unlockAudio` action so both paths behave identically.
      unlockAudio();
    };

    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
    };
  }, [unlockAudio]);

  // ── App suspend: release the mic mid-capture (#voice-V1) ───────────
  // On the installed iOS PWA, backgrounding suspends the WebAudio graph and
  // leaves the composer capture stuck (phantom "listening", orphaned mic). Tie
  // into #15179's lifecycle bridge (which dispatches APP_PAUSE on the web PWA)
  // to discard the in-flight capture cleanly. Only APP_PAUSE is handled here:
  // the composer mic is push-to-talk, so resume needs no auto-re-arm — the
  // hands-free/ambient surface (useShellController) owns re-arm on resume.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onPause = (): void => {
      discardCaptureForSuspend();
    };
    document.addEventListener(APP_PAUSE_EVENT, onPause);
    return () => {
      document.removeEventListener(APP_PAUSE_EVENT, onPause);
    };
  }, [discardCaptureForSuspend]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      void stopListening();
      void removeTalkModeListeners();
      stopSpeaking();
      if (micReconnectTimerRef.current !== null) {
        clearTimeout(micReconnectTimerRef.current);
        micReconnectTimerRef.current = null;
      }
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
    needsAudioUnlock,
    micReconnected,
    unlockAudio,
    assistantTtsQuality,
    ttsError,
  };
}
