/**
 * Bidirectional voice hook for chat + avatar lip sync.
 *
 * TTS providers (in priority order):
 *  1. ElevenLabs  — low-latency streaming endpoint + first-sentence cache.
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
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import {
  getTalkModePlugin,
  type TalkModeErrorEvent,
  type TalkModeStateEvent,
  type TalkModeTranscriptEvent,
} from "../bridge/native-plugins";
import { resolveApiUrl } from "../utils";
import { sanitizeSpeechText } from "../utils/spoken-text";
import { mergeStreamingText } from "../utils/streaming-text";

// ── Speech Recognition types ──────────────────────────────────────────

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionResultEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  };
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

// ── Public types ──────────────────────────────────────────────────────

type SpeechSegmentKind = "full" | "first-sentence" | "remainder";
type SpeechProviderKind = "elevenlabs" | "browser";
export type VoiceCaptureMode = "idle" | "compose" | "push-to-talk";

export interface VoicePlaybackStartEvent {
  text: string;
  segment: SpeechSegmentKind;
  provider: SpeechProviderKind;
  cached: boolean;
  startedAtMs: number;
}

export interface VoiceTranscriptPreviewEvent {
  mode: Exclude<VoiceCaptureMode, "idle">;
  isFinal: boolean;
}

export interface VoiceChatOptions {
  /** Called when a final transcript is ready to send */
  onTranscript: (text: string) => void;
  /** Called whenever the live transcript buffer changes */
  onTranscriptPreview?: (
    text: string,
    event: VoiceTranscriptPreviewEvent,
  ) => void;
  /** Called when playback of a speech segment starts */
  onPlaybackStart?: (event: VoicePlaybackStartEvent) => void;
  /** True when the user is authenticated to Milady/Eliza Cloud */
  cloudConnected?: boolean;
  /** Whether user speech should immediately interrupt assistant playback */
  interruptOnSpeech?: boolean;
  /** Language for speech recognition (default: "en-US") */
  lang?: string;
  /** Saved voice configuration — switches TTS provider when set */
  voiceConfig?: VoiceConfig | null;
}

export interface VoiceChatState {
  /** Whether voice input is currently active */
  isListening: boolean;
  /** Current mic capture mode */
  captureMode: VoiceCaptureMode;
  /** Whether the agent is currently speaking */
  isSpeaking: boolean;
  /** Current mouth openness (0-1) for lip sync */
  mouthOpen: number;
  /** Current interim transcript being recognized */
  interimTranscript: string;
  /** Whether Web Speech API is supported */
  supported: boolean;
  /** True when using real audio analysis (ElevenLabs) for mouth */
  usingAudioAnalysis: boolean;
  /** Toggle voice listening on/off */
  toggleListening: () => void;
  /** Begin voice capture in compose or push-to-talk mode */
  startListening: (mode?: Exclude<VoiceCaptureMode, "idle">) => Promise<void>;
  /** End voice capture and optionally submit the transcript */
  stopListening: (options?: { submit?: boolean }) => Promise<void>;
  /** Speak text aloud with mouth animation */
  speak: (text: string, options?: { append?: boolean }) => void;
  /** Progressively speak an assistant message while it streams */
  queueAssistantSpeech: (
    messageId: string,
    text: string,
    isFinal: boolean,
  ) => void;
  /** Stop any current speech */
  stopSpeaking: () => void;
}

interface SpeakTask {
  text: string;
  append: boolean;
  segment: SpeechSegmentKind;
  cacheKey?: string;
}

interface AssistantSpeechState {
  messageId: string;
  lastObservedText: string;
  firstSentenceSpoken: boolean;
  firstSentenceText: string;
  queuedRemainderText: string;
  finalQueued: boolean;
}

const DEFAULT_ELEVEN_MODEL = "eleven_flash_v2_5";
const DEFAULT_ELEVEN_VOICE = "EXAVITQu4vr4xnSDxMaL";
const MAX_SPOKEN_CHARS = 360;
const MAX_CACHED_SEGMENTS = 128;
const TALKMODE_STOP_SETTLE_MS = 120;
const REDACTED_SECRET = "[REDACTED]";
const MOUTH_OPEN_STEP = 0.02;
function resolveElevenProxyEndpoint(): string {
  return resolveApiUrl("/api/tts/elevenlabs");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeMouthOpen(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  const stepped = Math.round(clamped / MOUTH_OPEN_STEP) * MOUTH_OPEN_STEP;
  return stepped < MOUTH_OPEN_STEP ? 0 : Math.min(1, stepped);
}

export function nextIdleMouthOpen(currentValue: number): number {
  const current = normalizeMouthOpen(currentValue);
  if (current <= MOUTH_OPEN_STEP) {
    return 0;
  }
  return Math.max(0, Math.min(current * 0.85, current - MOUTH_OPEN_STEP));
}

function normalizeCacheText(input: string): string {
  // Preserve punctuation while normalizing spacing/casing.
  return collapseWhitespace(input.normalize("NFKC")).toLowerCase();
}

function isRedactedSecret(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toUpperCase() === REDACTED_SECRET
  );
}

function capSpeechLength(input: string): string {
  if (input.length <= MAX_SPOKEN_CHARS) return input;
  const clipped = input.slice(0, MAX_SPOKEN_CHARS);
  const splitAt = clipped.lastIndexOf(" ");
  const body = splitAt > 120 ? clipped.slice(0, splitAt) : clipped;
  return `${body.trim()}...`;
}

function toSpeakableText(input: string): string {
  const normalized = sanitizeSpeechText(input);
  if (!normalized) return "";
  return capSpeechLength(normalized);
}

function splitFirstSentence(text: string): {
  complete: boolean;
  firstSentence: string;
  remainder: string;
} {
  const value = collapseWhitespace(text);
  if (!value) return { complete: false, firstSentence: "", remainder: "" };

  const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
  const match = boundary.exec(value);
  if (match && typeof match.index === "number") {
    const endIndex = match.index + match[0].length;
    const firstSentence = value.slice(0, endIndex).trim();
    const remainder = value.slice(endIndex).trim();
    if (firstSentence.length > 0) {
      return { complete: true, firstSentence, remainder };
    }
  }

  // Fallback for long content with no punctuation yet.
  if (value.length >= 180) {
    const window = value.slice(0, 180);
    const splitAt = window.lastIndexOf(" ");
    if (splitAt > 100) {
      return {
        complete: true,
        firstSentence: window.slice(0, splitAt).trim(),
        remainder: value.slice(splitAt).trim(),
      };
    }
  }

  return { complete: false, firstSentence: value, remainder: "" };
}

function remainderAfter(fullText: string, firstSentence: string): string {
  const full = collapseWhitespace(fullText);
  const first = collapseWhitespace(firstSentence);
  if (!full || !first) return full;
  if (full.startsWith(first)) return full.slice(first.length).trim();

  const lowerFull = full.toLowerCase();
  const lowerFirst = first.toLowerCase();
  if (lowerFull.startsWith(lowerFirst)) {
    return full.slice(first.length).trim();
  }

  const idx = lowerFull.indexOf(lowerFirst);
  if (idx >= 0) {
    return full.slice(idx + first.length).trim();
  }

  return "";
}

function queueableSpeechPrefix(text: string, isFinal: boolean): string {
  const value = collapseWhitespace(text);
  if (!value) return "";
  if (isFinal) return value;

  let lastSentenceEnd = 0;
  const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = boundary.exec(value);
    if (!match || typeof match.index !== "number") break;
    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 0) {
    return value.slice(0, lastSentenceEnd).trim();
  }

  // Fallback for long content with no punctuation yet.
  if (value.length >= 180) {
    const window = value.slice(0, 180);
    const splitAt = window.lastIndexOf(" ");
    if (splitAt > 100) {
      return window.slice(0, splitAt).trim();
    }
  }
  return "";
}

function cloneVoiceConfig(
  config: VoiceConfig | null | undefined,
): VoiceConfig | null {
  if (!config) return null;
  return {
    ...config,
    elevenlabs: config.elevenlabs ? { ...config.elevenlabs } : undefined,
    edge: config.edge ? { ...config.edge } : undefined,
  };
}

function resolveEffectiveVoiceConfig(
  config: VoiceConfig | null | undefined,
  options?: { cloudConnected?: boolean },
): VoiceConfig | null {
  const cloudConnected = options?.cloudConnected === true;
  const base = cloneVoiceConfig(config) ?? {};
  const provider =
    base.provider ??
    (base.elevenlabs ? "elevenlabs" : base.edge ? "edge" : undefined) ??
    (cloudConnected ? "elevenlabs" : undefined);

  if (!provider) return null;
  if (provider !== "elevenlabs") {
    return { ...base, provider };
  }

  const mode = base.mode ?? (cloudConnected ? "cloud" : "own-key");
  const currentElevenLabs = base.elevenlabs ?? {};
  const elevenlabs: NonNullable<VoiceConfig["elevenlabs"]> = {
    ...currentElevenLabs,
    voiceId: currentElevenLabs.voiceId ?? DEFAULT_ELEVEN_VOICE,
    modelId: currentElevenLabs.modelId ?? DEFAULT_ELEVEN_MODEL,
    stability:
      typeof currentElevenLabs.stability === "number"
        ? currentElevenLabs.stability
        : 0.5,
    similarityBoost:
      typeof currentElevenLabs.similarityBoost === "number"
        ? currentElevenLabs.similarityBoost
        : 0.75,
    speed:
      typeof currentElevenLabs.speed === "number"
        ? currentElevenLabs.speed
        : 1.0,
  };
  const apiKey =
    typeof currentElevenLabs.apiKey === "string"
      ? currentElevenLabs.apiKey.trim()
      : "";

  if (mode === "own-key" && apiKey && !isRedactedSecret(apiKey)) {
    elevenlabs.apiKey = currentElevenLabs.apiKey;
  } else {
    delete elevenlabs.apiKey;
  }

  return {
    ...base,
    provider,
    mode,
    elevenlabs,
  };
}

export const __voiceChatInternals = {
  splitFirstSentence,
  remainderAfter,
  queueableSpeechPrefix,
  resolveEffectiveVoiceConfig,
  toSpeakableText,
};

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

function shouldPreferNativeTalkMode(): boolean {
  if (typeof window === "undefined") return false;
  if (getElectrobunRendererRpc()) return true;
  return Capacitor.isNativePlatform();
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useVoiceChat(options: VoiceChatOptions): VoiceChatState {
  const [isListening, setIsListening] = useState(false);
  const [captureMode, setCaptureMode] = useState<VoiceCaptureMode>("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [supported, setSupported] = useState(false);
  const [usingAudioAnalysis, setUsingAudioAnalysis] = useState(false);

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
  const emitTranscript = useEffectEvent((text: string) => {
    options.onTranscript(text);
  });
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

  // Voice config ref (latest value always available to callbacks)
  const voiceConfigRef = useRef<VoiceConfig | null>(effectiveVoiceConfig);
  voiceConfigRef.current = effectiveVoiceConfig;
  const interruptOnSpeechRef = useRef(options.interruptOnSpeech ?? true);
  interruptOnSpeechRef.current = options.interruptOnSpeech ?? true;
  const interruptSpeechRef = useRef<() => void>(() => {});

  // ── ElevenLabs Web Audio refs ──────────────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
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
  const elevenCacheRef = useRef<Map<string, Uint8Array>>(new Map());

  const clearSpeechTimers = useCallback(() => {
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
  }, []);

  const rememberCachedSegment = useCallback(
    (key: string, bytes: Uint8Array) => {
      const cache = elevenCacheRef.current;
      cache.delete(key);
      cache.set(key, bytes);
      if (cache.size <= MAX_CACHED_SEGMENTS) return;
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
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
    const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const canUseMicrophone =
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function";
    setSupported(
      shouldPreferNativeTalkMode()
        ? canUseMicrophone || !!SpeechRecognitionAPI
        : !!SpeechRecognitionAPI,
    );
    synthRef.current = window.speechSynthesis ?? null;
  }, []);

  useEffect(() => {
    elevenCacheRef.current.clear();
  }, []);

  // ── Mouth animation loop ──────────────────────────────────────────

  useEffect(() => {
    let frameId = 0;

    const animate = () => {
      if (!isSpeaking) {
        const nextMouthOpen = nextIdleMouthOpen(mouthOpenRef.current);
        updateMouthOpen(nextMouthOpen);
        if (nextMouthOpen > 0) {
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
    (transcript: string, isFinal: boolean) => {
      const mode = listeningModeRef.current;
      if (mode === "idle") return;

      const normalized = collapseWhitespace(transcript);
      if (!normalized) return;

      const nextText = mergeStreamingText(
        transcriptBufferRef.current,
        normalized,
      );
      if (nextText === transcriptBufferRef.current) return;

      transcriptBufferRef.current = nextText;
      setInterimTranscript(nextText);
      emitTranscriptPreview(nextText, {
        mode,
        isFinal,
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

  const ensureTalkModeListeners = useCallback(async () => {
    if (talkModeHandlesRef.current.length > 0) return;

    const talkMode = getTalkModePlugin();

    const transcriptHandle = await talkMode.addListener(
      "transcript",
      (event: TalkModeTranscriptEvent) => {
        applyTranscriptUpdate(event.transcript ?? "", event.isFinal === true);
      },
    );
    const errorHandle = await talkMode.addListener(
      "error",
      (event: TalkModeErrorEvent) => {
        if (
          event.code === "not-allowed" ||
          event.code === "service-not-allowed"
        ) {
          enabledRef.current = false;
          listeningModeRef.current = "idle";
          sttBackendRef.current = null;
          setCaptureMode("idle");
          setIsListening(false);
        }
      },
    );
    const stateHandle = await talkMode.addListener(
      "stateChange",
      (event: TalkModeStateEvent) => {
        if (event.state === "error" || event.state === "idle") {
          if (!enabledRef.current) {
            setIsListening(false);
            setCaptureMode("idle");
          }
        }
      },
    );
    talkModeHandlesRef.current = [transcriptHandle, errorHandle, stateHandle];
  }, [applyTranscriptUpdate]);

  const startBrowserRecognition = useCallback(
    (mode: Exclude<VoiceCaptureMode, "idle">) => {
      const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
        window.SpeechRecognition ?? window.webkitSpeechRecognition;
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
        if (enabledRef.current && listeningModeRef.current === mode) {
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
      await ensureTalkModeListeners();

      try {
        const talkMode = getTalkModePlugin();
        const permissions = await talkMode.checkPermissions().catch(() => null);
        if (permissions?.microphone === "prompt") {
          await talkMode.requestPermissions().catch(() => {
            /* ignore */
          });
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
          return false;
        }

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

  const finalizeRecognition = useCallback((submit: boolean) => {
    const transcript = collapseWhitespace(transcriptBufferRef.current);
    if (submit && transcript) {
      emitTranscript(transcript);
    }

    transcriptBufferRef.current = "";
    recognitionRef.current = null;
    sttBackendRef.current = null;
    enabledRef.current = false;
    listeningModeRef.current = "idle";
    setIsListening(false);
    setCaptureMode("idle");
    setInterimTranscript("");
  }, []);

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

      startBrowserRecognition(mode);
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
        await getTalkModePlugin().stop().catch(() => {
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
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          // Force a fresh context if resume fails
          ctx.close().catch(() => {});
          ctx = new AudioContext();
          audioCtxRef.current = ctx;
        }
      }

      const voiceId = elConfig.voiceId ?? DEFAULT_ELEVEN_VOICE;
      const modelId = elConfig.modelId ?? DEFAULT_ELEVEN_MODEL;

      const cacheKey = task.cacheKey ?? makeElevenCacheKey(text, elConfig);
      const cachedBytes = elevenCacheRef.current.get(cacheKey);
      let audioBytes: Uint8Array | null = null;
      let cached = false;

      if (cachedBytes) {
        elevenCacheRef.current.delete(cacheKey);
        elevenCacheRef.current.set(cacheKey, cachedBytes);
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
        const apiToken =
          typeof window !== "undefined" &&
          typeof window.__MILADY_API_TOKEN__ === "string"
            ? window.__MILADY_API_TOKEN__.trim()
            : "";

        const fetchViaProxy = async () => {
          return fetch(resolveElevenProxyEndpoint(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
              ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
            },
            body: JSON.stringify({
              ...requestBody,
              voiceId,
              modelId,
              outputFormat: "mp3_44100_128",
            }),
            signal: controller.signal,
          });
        };

        const trimmedApiKey =
          typeof elConfig.apiKey === "string" ? elConfig.apiKey.trim() : "";
        const hasDirectKey =
          trimmedApiKey.length > 0 && !isRedactedSecret(trimmedApiKey);

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
            res = await fetchViaProxy();
          }

          // If the locally-available key is stale, fall back to server-side key.
          if (!res.ok && (res.status === 401 || res.status === 403)) {
            const proxyRes = await fetchViaProxy();
            if (proxyRes.ok) {
              res = proxyRes;
            }
          }
        } else {
          res = await fetchViaProxy();
        }

        if (activeFetchAbortRef.current === controller) {
          activeFetchAbortRef.current = null;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
        }

        const audioData = await res.arrayBuffer();
        audioBytes = new Uint8Array(audioData);
        rememberCachedSegment(cacheKey, audioBytes.slice());
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
        const finish = () => {
          if (finished) return;
          finished = true;
          if (activeTaskFinishRef.current === finish) {
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

        activeTaskFinishRef.current = finish;
        source.onended = finish;

        speechTimeoutRef.current = setTimeout(
          finish,
          Math.max(2500, Math.ceil(audioBuffer.duration * 1000) + 1200),
        );

        source.start(0);
        emitPlaybackStart({
          text,
          segment: task.segment,
          provider: "elevenlabs",
          cached,
          startedAtMs: performance.now(),
        });
      });
    },
    [clearSpeechTimers, makeElevenCacheKey, rememberCachedSegment],
  );

  // ── Browser SpeechSynthesis TTS ───────────────────────────────────

  const speakBrowser = useCallback(
    (text: string, task: SpeakTask, generation: number) => {
      const synth = synthRef.current;
      const words = text.trim().split(/\s+/).length;
      const estimatedMs = Math.max(1200, (words / 3) * 1000);

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
          emitPlaybackStart({
            text,
            segment: task.segment,
            provider: "browser",
            cached: false,
            startedAtMs: performance.now(),
          });
          speechTimeoutRef.current = setTimeout(finish, estimatedMs);
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text.trim());
        utteranceRef.current = utterance;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.onstart = () => {
          if (generation !== generationRef.current) return;
          emitPlaybackStart({
            text,
            segment: task.segment,
            provider: "browser",
            cached: false,
            startedAtMs: performance.now(),
          });
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        synth.speak(utterance);

        speechTimeoutRef.current = setTimeout(finish, estimatedMs + 5000);
      });
    },
    [clearSpeechTimers],
  );

  const processQueue = useCallback(() => {
    if (queueWorkerRunningRef.current) return;
    queueWorkerRunningRef.current = true;
    const workerGeneration = generationRef.current;

    void (async () => {
      try {
        while (queueRef.current.length > 0) {
          if (workerGeneration !== generationRef.current) return;
          const task = queueRef.current.shift();
          if (!task) break;

          const config = voiceConfigRef.current;
          const elConfig = config?.elevenlabs;
          const useElevenLabs = config?.provider === "elevenlabs";

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
                return;
              }
              console.warn(
                "[useVoiceChat] ElevenLabs TTS failed, falling back to browser:",
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : error,
              );
              usingAudioAnalysisRef.current = false;
              setUsingAudioAnalysis(false);
            }
          } else {
            usingAudioAnalysisRef.current = false;
            setUsingAudioAnalysis(false);
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
  }, [speakBrowser, speakElevenLabs]);

  const enqueueSpeech = useCallback(
    (task: SpeakTask) => {
      const speakable = toSpeakableText(task.text);
      if (!speakable) return;

      if (!task.append) {
        cancelPlayback();
      }

      queueRef.current.push({ ...task, text: speakable });
      speakingStartRef.current = Date.now();
      setIsSpeaking(true);
      processQueue();
    },
    [cancelPlayback, processQueue],
  );

  // ── Public speak APIs ─────────────────────────────────────────────

  const speak = useCallback(
    (text: string, speakOptions?: { append?: boolean }) => {
      assistantSpeechRef.current = null;
      enqueueSpeech({
        text,
        append: Boolean(speakOptions?.append),
        segment: "full",
      });
    },
    [enqueueSpeech],
  );

  const queueAssistantSpeech = useCallback(
    (messageId: string, text: string, isFinal: boolean) => {
      if (!messageId) return;

      const speakable = toSpeakableText(text);
      if (!speakable) return;

      const current = assistantSpeechRef.current;
      if (!current || current.messageId !== messageId) {
        assistantSpeechRef.current = {
          messageId,
          lastObservedText: "",
          firstSentenceSpoken: false,
          firstSentenceText: "",
          queuedRemainderText: "",
          finalQueued: false,
        };
      }

      const state = assistantSpeechRef.current;
      if (!state) return;

      if (
        speakable === state.lastObservedText &&
        (!isFinal || state.finalQueued)
      ) {
        return;
      }
      state.lastObservedText = speakable;

      if (!state.firstSentenceSpoken) {
        const split = splitFirstSentence(speakable);
        if (!split.complete && !isFinal) return;

        if (split.complete) {
          const firstSentence = split.firstSentence;
          state.firstSentenceSpoken = true;
          state.firstSentenceText = firstSentence;

          const elConfig = voiceConfigRef.current?.elevenlabs;
          const cacheKey =
            voiceConfigRef.current?.provider === "elevenlabs" && elConfig
              ? makeElevenCacheKey(firstSentence, elConfig)
              : undefined;

          enqueueSpeech({
            text: firstSentence,
            append: false,
            segment: "first-sentence",
            cacheKey,
          });

          const queueableRemainder = queueableSpeechPrefix(
            split.remainder,
            isFinal,
          );
          if (queueableRemainder) {
            enqueueSpeech({
              text: queueableRemainder,
              append: true,
              segment: "remainder",
            });
            state.queuedRemainderText = queueableRemainder;
          }
          if (isFinal) {
            state.finalQueued = true;
          }
          return;
        }

        enqueueSpeech({
          text: speakable,
          append: false,
          segment: "full",
        });
        state.finalQueued = true;
        return;
      }

      const remainder = remainderAfter(speakable, state.firstSentenceText);
      const queueableRemainder = queueableSpeechPrefix(remainder, isFinal);
      const newRemainderDelta = remainderAfter(
        queueableRemainder,
        state.queuedRemainderText,
      );
      if (newRemainderDelta) {
        enqueueSpeech({
          text: newRemainderDelta,
          append: true,
          segment: "remainder",
        });
        state.queuedRemainderText = queueableRemainder;
      }

      if (isFinal && !state.finalQueued) {
        state.finalQueued = true;
      }
    },
    [enqueueSpeech, makeElevenCacheKey],
  );

  // ── Keep ElevenLabs runtime warm for lower startup latency ────────

  useEffect(() => {
    const config = effectiveVoiceConfig;
    if (
      typeof window === "undefined" ||
      config?.provider !== "elevenlabs" ||
      !config.elevenlabs
    ) {
      return;
    }

    const warmAudioContext = () => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }

      void audioCtxRef.current.resume().catch(() => {
        // Ignore until the next gesture or playback attempt.
      });
    };
    const handleUserGesture = () => {
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
      warmAudioContext();
    };

    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
    };
  }, [effectiveVoiceConfig]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      void stopListening();
      void removeTalkModeListeners();
      stopSpeaking();
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {
          /* ignore */
        });
        audioCtxRef.current = null;
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
  };
}
