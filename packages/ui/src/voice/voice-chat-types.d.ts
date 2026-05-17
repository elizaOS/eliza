/**
 * Types, constants, and config interfaces for the voice chat system.
 */
import type { VoiceConfig, VoiceMode } from "../api/client";
import type { Emotion } from "./emotion";
export interface SpeechRecognitionInstance extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: ((event: {
        error: string;
    }) => void) | null;
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
        0: {
            transcript: string;
            confidence: number;
        };
    };
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
export type WindowWithSpeechRecognition = Omit<Window, "SpeechRecognition" | "webkitSpeechRecognition"> & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
};
/** Access browser SpeechRecognition APIs which may live under a vendor prefix. */
export declare function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined;
export type SpeechSegmentKind = "full" | "first-sentence" | "remainder";
export type SpeechProviderKind = "elevenlabs" | "browser" | "local-inference";
export type VoiceSessionMode = "idle" | "compose" | "push-to-talk" | "hands-free" | "passive";
export type VoiceCaptureMode = VoiceSessionMode;
/**
 * Continuous-chat mode (R10 §2.1).
 *
 * - `off`: classic push-to-talk only.
 * - `vad-gated`: mic opens only after VAD start, closes after end-of-turn.
 *   Default for laptop on battery / mobile on cellular.
 * - `always-on`: mic stays open continuously; turn-detector segments turns.
 *   Default for desktop on power / mobile on power.
 */
export type VoiceContinuousMode = "off" | "vad-gated" | "always-on";
export declare const VOICE_CONTINUOUS_MODES: readonly VoiceContinuousMode[];
export declare const DEFAULT_VOICE_CONTINUOUS_MODE: VoiceContinuousMode;
/**
 * Status surfaced in the chat status bar while continuous chat is active.
 */
export type VoiceContinuousStatus = "idle" | "listening" | "thinking" | "speaking" | "interrupting";
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
    onTranscriptPreview?: (text: string, event: VoiceTranscriptPreviewEvent) => void;
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
    stopListening: (options?: {
        submit?: boolean;
    }) => Promise<void>;
    /** Speak text aloud with mouth animation */
    speak: (text: string, options?: {
        append?: boolean;
        telemetry?: VoiceAssistantSpeechTelemetry;
    }) => void;
    /** Progressively speak an assistant message while it streams */
    queueAssistantSpeech: (messageId: string, text: string, isFinal: boolean, options?: QueueAssistantSpeechOptions) => void;
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
export declare const DEFAULT_ELEVEN_MODEL = "eleven_flash_v2_5";
export declare const DEFAULT_ELEVEN_VOICE = "EXAVITQu4vr4xnSDxMaL";
export declare const MAX_SPOKEN_CHARS = 4000;
export declare const MAX_CACHED_SEGMENTS = 128;
/** Cache only short generated clips aggressively; common acknowledgements stay hot. */
export declare const SHORT_AUDIO_CACHE_MAX_TOKENS = 10;
/** First assistant clip: start synthesis after this much speakable text (avoids one-word TTS). */
export declare const ASSISTANT_TTS_FIRST_FLUSH_CHARS = 24;
/** Later clips: batch for better prosody (avoid token-thin slices). */
export declare const ASSISTANT_TTS_MIN_CHUNK_CHARS = 88;
/** Merge rapid stream deltas into one request after a short pause. */
export declare const ASSISTANT_TTS_DEBOUNCE_MS = 170;
/** Stream assistant speech progressively; queueing keeps chunks serialized. */
export declare const ASSISTANT_TTS_FINAL_ONLY = false;
export declare const TALKMODE_STOP_SETTLE_MS = 120;
export declare const REDACTED_SECRET = "[REDACTED]";
export declare const MOUTH_OPEN_STEP = 0.02;
export declare const globalAudioCache: Map<string, Uint8Array<ArrayBufferLike>>;
export declare function resolveVoiceMode(mode: VoiceMode | undefined, _cloudConnected: boolean, _apiKey?: string | null): VoiceMode;
export declare function resolveVoiceProxyEndpoint(mode: VoiceMode): string;
/** For ELIZA_TTS_DEBUG: shows whether cloud TTS hits the API or the wrong (page) origin. */
export declare function describeTtsCloudFetchTargetForDebug(): string;
export declare function cloneVoiceConfig(config: (VoiceConfig & {
    provider?: VoiceConfig["provider"] | "openai";
    openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
    };
}) | null | undefined): (VoiceConfig & {
    provider?: VoiceConfig["provider"] | "openai";
    openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
    };
}) | null;
export declare function resolveEffectiveVoiceConfig(config: (VoiceConfig & {
    provider?: VoiceConfig["provider"] | "openai";
    openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
    };
}) | null | undefined, options?: {
    cloudConnected?: boolean;
}): (VoiceConfig & {
    provider?: VoiceConfig["provider"] | "openai";
    openai?: {
        apiKey?: string;
        voice?: string;
        model?: string;
    };
}) | null;
export declare function isAbortError(error: unknown): boolean;
/** ELIZA_TTS_DEBUG fields for OS/browser SpeechSynthesis (often Microsoft Edge on Windows). */
export declare function webSpeechVoiceDebugFields(voice: SpeechSynthesisVoice | undefined): Record<string, string | boolean | undefined>;
export declare function normalizeSpeechLocale(input: string | undefined): string;
export declare function localePrefix(locale: string): string;
export declare function matchesVoiceLocale(voice: SpeechSynthesisVoice, targetLocale: string): boolean;
export declare function toArrayBuffer(bytes: Uint8Array): ArrayBuffer;
//# sourceMappingURL=voice-chat-types.d.ts.map