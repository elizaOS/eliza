/**
 * Types, constants, and config interfaces for the voice chat system.
 */

import type { VoiceConfig, VoiceMode } from "../api/client";
import { resolveApiUrl } from "../utils";
import { ttsDebug } from "../utils/tts-debug";
import type { Emotion } from "./emotion";

// ── Speech Recognition types ──────────────────────────────────────────

export interface SpeechRecognitionInstance extends EventTarget {
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

export interface SpeechRecognitionResultEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

export interface SpeechRecognitionResultList {
  length: number;
  [index: number]: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  };
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

export interface WindowWithSpeechRecognition extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

function isSpeechRecognitionCtor(
  value: unknown,
): value is SpeechRecognitionCtor {
  return typeof value === "function" && "prototype" in value;
}

/** Access browser SpeechRecognition APIs which may live under a vendor prefix. */
export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const speechRecognition: unknown = Reflect.get(window, "SpeechRecognition");
  if (isSpeechRecognitionCtor(speechRecognition)) {
    return speechRecognition;
  }

  const webkitSpeechRecognition: unknown = Reflect.get(
    window,
    "webkitSpeechRecognition",
  );
  return isSpeechRecognitionCtor(webkitSpeechRecognition)
    ? webkitSpeechRecognition
    : undefined;
}

// ── Public types ──────────────────────────────────────────────────────

export type SpeechSegmentKind = "full" | "first-sentence" | "remainder";
export type SpeechProviderKind = "elevenlabs" | "browser" | "local-inference";
export type VoiceSessionMode =
  | "idle"
  | "compose"
  | "push-to-talk"
  | "hands-free"
  | "passive";
export type VoiceCaptureMode = VoiceSessionMode;

export interface VoiceSpeakerMetadata {
  /** Stable app/runtime entity id for the speaker when a connector can provide one. */
  entityId?: string;
  /** Connector-native speaker id, such as a Discord user id. */
  sourceId?: string;
  /** Connector/source label, such as "discord", "browser", or "talkmode". */
  source?: string;
  /** Human-friendly display name. */
  name?: string;
  /** Connector username or handle. */
  userName?: string;
  /** Room/channel where the turn was captured. */
  channelId?: string;
  roomId?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceTurn {
  /** Stable id for this captured speech turn when available. */
  id?: string;
  text: string;
  mode: VoiceSessionMode;
  isFinal: boolean;
  speaker?: VoiceSpeakerMetadata;
  source?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface VoiceTranscriptEvent {
  text: string;
  mode: Exclude<VoiceSessionMode, "idle">;
  isFinal: boolean;
  turn: VoiceTurn;
  speaker?: VoiceSpeakerMetadata;
}

export interface VoicePlaybackStartEvent {
  text: string;
  segment: SpeechSegmentKind;
  provider: SpeechProviderKind;
  cached: boolean;
  startedAtMs: number;
  messageId?: string;
  voiceTurnId?: string;
  speechEndedAtMs?: number;
  assistantFirstTextAtMs?: number;
  assistantTextUpdatedAtMs?: number;
  queuedAtMs?: number;
}

export interface VoiceTranscriptPreviewEvent {
  text: string;
  mode: Exclude<VoiceSessionMode, "idle">;
  isFinal: boolean;
  turn: VoiceTurn;
  speaker?: VoiceSpeakerMetadata;
}

export interface VoiceChatOptions {
  /** Called when a final transcript is ready to send */
  onTranscript: (text: string, event: VoiceTranscriptEvent) => void;
  /** Called whenever the live transcript buffer changes */
  onTranscriptPreview?: (
    text: string,
    event: VoiceTranscriptPreviewEvent,
  ) => void;
  /** Called when playback of a speech segment starts */
  onPlaybackStart?: (event: VoicePlaybackStartEvent) => void;
  /** True when Eliza Cloud-managed voice access is available */
  cloudConnected?: boolean;
  /** Whether user speech should immediately interrupt assistant playback */
  interruptOnSpeech?: boolean;
  /** Language for speech recognition (default: "en-US") */
  lang?: string;
  /** Saved voice configuration — switches TTS provider when set */
  voiceConfig?: VoiceConfig | null;
}

export interface VoiceAssistantSpeechTelemetry {
  /** Assistant message whose visible text is being spoken. */
  messageId?: string;
  /** User voice turn that caused this assistant output. */
  voiceTurnId?: string;
  /** UI monotonic timestamp for final transcript receipt / speech end. */
  speechEndedAtMs?: number;
  /** UI monotonic timestamp when this assistant message first had visible text. */
  assistantFirstTextAtMs?: number;
  /** UI monotonic timestamp for this visible text update. */
  assistantTextUpdatedAtMs?: number;
}

export interface QueueAssistantSpeechOptions {
  /**
   * Replace current playback for the first clip of a new assistant message.
   * Leave enabled for single-message stream corrections; disable when appending
   * additional visible assistant turns from the same voice response.
   */
  replace?: boolean;
  telemetry?: VoiceAssistantSpeechTelemetry;
  /** Emotion hint forwarded to the TTS provider (see SpeakTask.emotion). */
  emotion?: Emotion;
  /** Route through the singing-model codepath (see SpeakTask.singing). */
  singing?: boolean;
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
  /** Begin voice capture in an active session mode */
  startListening: (mode?: Exclude<VoiceSessionMode, "idle">) => Promise<void>;
  /** End voice capture and optionally submit the transcript */
  stopListening: (options?: { submit?: boolean }) => Promise<void>;
  /** Speak text aloud with mouth animation */
  speak: (text: string, options?: { append?: boolean }) => void;
  /** Progressively speak an assistant message while it streams */
  queueAssistantSpeech: (
    messageId: string,
    text: string,
    isFinal: boolean,
    options?: QueueAssistantSpeechOptions,
  ) => void;
  /** Stop any current speech */
  stopSpeaking: () => void;
  /** Increments when AudioContext is unlocked by a user gesture, allowing callers to retry speech that was silently blocked by autoplay policy. */
  voiceUnlockedGeneration: number;
  /**
   * Assistant reply TTS: `enhanced` = ElevenLabs path (own key, cloud proxy, or direct);
   * `standard` = browser / Edge voices or non-ElevenLabs provider.
   */
  assistantTtsQuality: "enhanced" | "standard";
}

export interface SpeakTask {
  text: string;
  append: boolean;
  segment: SpeechSegmentKind;
  cacheKey?: string;
  /**
   * Optional emotion hint forwarded to providers that support it
   * (omnivoice voice-design `instruct`, ElevenLabs `voice_settings.style`).
   * Providers that ignore emotion just drop the field.
   */
  emotion?: Emotion;
  /**
   * Route this clip through the singing-model codepath (omnivoice singing
   * GGUF). Providers without a singing variant treat this as a no-op and
   * fall back to standard TTS.
   */
  singing?: boolean;
  /** App-only: sent as `x-elizaos-tts-*` headers on `/api/tts/*` when debug is on (never forwarded to Eliza Cloud). */
  debugUtteranceContext?: {
    messageId: string;
    fullAssistTextPreview: string;
  };
  telemetry?: VoiceAssistantSpeechTelemetry & {
    queuedAtMs?: number;
  };
}

export interface AssistantSpeechState {
  messageId: string;
  /** Speakable text already submitted to the playback queue (prefix of current stream). */
  queuedSpeakablePrefix: string;
  /** Latest speakable from the stream (debounce flush reads this). */
  latestSpeakable: string;
  finalQueued: boolean;
  replacePlaybackOnFirstClip: boolean;
  telemetry?: VoiceAssistantSpeechTelemetry;
}

// ── Constants ─────────────────────────────────────────────────────────

export const DEFAULT_ELEVEN_MODEL = "eleven_flash_v2_5";
export const DEFAULT_ELEVEN_VOICE = "EXAVITQu4vr4xnSDxMaL";
export const MAX_SPOKEN_CHARS = 360;
export const MAX_CACHED_SEGMENTS = 128;
/** Cache only short generated clips aggressively; common acknowledgements stay hot. */
export const SHORT_AUDIO_CACHE_MAX_TOKENS = 10;
/** First assistant clip: start synthesis after this much speakable text (avoids one-word TTS). */
export const ASSISTANT_TTS_FIRST_FLUSH_CHARS = 24;
/** Later clips: batch for better prosody (avoid token-thin slices). */
export const ASSISTANT_TTS_MIN_CHUNK_CHARS = 88;
/** Merge rapid stream deltas into one request after a short pause. */
export const ASSISTANT_TTS_DEBOUNCE_MS = 170;
/** Stream assistant speech progressively; queueing keeps chunks serialized. */
export const ASSISTANT_TTS_FINAL_ONLY = false;
export const TALKMODE_STOP_SETTLE_MS = 120;
export const REDACTED_SECRET = "[REDACTED]";
export const MOUTH_OPEN_STEP = 0.02;

export const globalAudioCache = new Map<string, Uint8Array>();

// ── Voice config helpers ──────────────────────────────────────────────

export function resolveVoiceMode(
  mode: VoiceMode | undefined,
  _cloudConnected: boolean,
  _apiKey?: string | null,
): VoiceMode {
  if (mode) return mode;
  return "own-key";
}

export function resolveVoiceProxyEndpoint(mode: VoiceMode): string {
  return resolveApiUrl(
    mode === "cloud" ? "/api/tts/cloud" : "/api/tts/elevenlabs",
  );
}

/** For ELIZA_TTS_DEBUG: shows whether cloud TTS hits the API or the wrong (page) origin. */
export function describeTtsCloudFetchTargetForDebug(): string {
  const target = resolveApiUrl("/api/tts/cloud");
  if (/^https?:\/\//i.test(target)) {
    try {
      return `${new URL(target).origin} (absolute)`;
    } catch {
      return target.slice(0, 120);
    }
  }
  const origin =
    typeof window !== "undefined" ? window.location.origin : "(no-window)";
  const path = target.startsWith("/") ? target : `/${target}`;
  return `${origin}${path} — relative URL (TTS fetch goes to the UI host, not the app API). Set __ELIZAOS_API_BASE__ / session elizaos_api_base / boot apiBase to http://127.0.0.1:<apiPort>`;
}

function isRedactedSecret(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toUpperCase() === REDACTED_SECRET
  );
}

export function cloneVoiceConfig(
  config:
    | (VoiceConfig & {
        provider?: VoiceConfig["provider"] | "openai";
        openai?: {
          apiKey?: string;
          voice?: string;
          model?: string;
        };
      })
    | null
    | undefined,
):
  | (VoiceConfig & {
      provider?: VoiceConfig["provider"] | "openai";
      openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
      };
    })
  | null {
  if (!config) return null;
  return {
    ...config,
    elevenlabs: config.elevenlabs ? { ...config.elevenlabs } : undefined,
    edge: config.edge ? { ...config.edge } : undefined,
    openai: config.openai ? { ...config.openai } : undefined,
  };
}

export function resolveEffectiveVoiceConfig(
  config:
    | (VoiceConfig & {
        provider?: VoiceConfig["provider"] | "openai";
        openai?: {
          apiKey?: string;
          voice?: string;
          model?: string;
        };
      })
    | null
    | undefined,
  options?: { cloudConnected?: boolean },
):
  | (VoiceConfig & {
      provider?: VoiceConfig["provider"] | "openai";
      openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
      };
    })
  | null {
  const cloudConnected = options?.cloudConnected === true;
  const base = cloneVoiceConfig(config) ?? {};
  const rawProvider = base.provider as
    | VoiceConfig["provider"]
    | "openai"
    | undefined;
  const hasLegacyOpenAiProvider = rawProvider === "openai";
  let provider: VoiceConfig["provider"] | undefined =
    (hasLegacyOpenAiProvider ? undefined : rawProvider) ??
    (base.elevenlabs ? "elevenlabs" : base.edge ? "edge" : undefined) ??
    (cloudConnected ? "elevenlabs" : undefined);

  if (
    cloudConnected &&
    (provider === "edge" ||
      hasLegacyOpenAiProvider ||
      provider === "robot-voice")
  ) {
    ttsDebug("voiceConfig:upgrade_provider_for_cloud", {
      fromProvider: hasLegacyOpenAiProvider ? "openai" : provider,
    });
    provider = "elevenlabs";
  }

  if (!provider) return null;
  if (provider !== "elevenlabs") {
    return { ...base, provider };
  }

  const currentElevenLabs = base.elevenlabs ?? {};
  const mode = resolveVoiceMode(
    base.mode,
    cloudConnected,
    currentElevenLabs.apiKey,
  );
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

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/** ELIZA_TTS_DEBUG fields for OS/browser SpeechSynthesis (often Microsoft Edge on Windows). */
export function webSpeechVoiceDebugFields(
  voice: SpeechSynthesisVoice | undefined,
): Record<string, string | boolean | undefined> {
  if (!voice) {
    return {
      voiceName: "(engine default)",
      voiceURI: "(none)",
      engineGuess: "unknown",
    };
  }
  const blob = `${voice.voiceURI} ${voice.name}`.toLowerCase();
  let engineGuess = "unknown";
  if (
    blob.includes("microsoft") ||
    blob.includes("msedge") ||
    blob.includes("edge-tts")
  ) {
    engineGuess = "microsoft-edge-family";
  } else if (blob.includes("com.apple")) {
    engineGuess = "apple-webkit";
  } else if (blob.includes("google")) {
    engineGuess = "google";
  }
  const extended = voice as SpeechSynthesisVoice & { localService?: boolean };
  return {
    voiceName: voice.name,
    voiceURI: voice.voiceURI,
    voiceLang: voice.lang,
    voiceDefault: voice.default,
    voiceLocalService:
      typeof extended.localService === "boolean"
        ? extended.localService
        : undefined,
    engineGuess,
  };
}

export function normalizeSpeechLocale(input: string | undefined): string {
  const trimmed = input?.trim();
  return trimmed || "en-US";
}

export function localePrefix(locale: string): string {
  return locale.toLowerCase().split("-")[0] || "en";
}

export function matchesVoiceLocale(
  voice: SpeechSynthesisVoice,
  targetLocale: string,
): boolean {
  const target = targetLocale.toLowerCase();
  const voiceLang = voice.lang.toLowerCase();
  if (voiceLang === target) return true;
  const base = localePrefix(targetLocale);
  return voiceLang.startsWith(`${base}-`) || voiceLang === base;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
