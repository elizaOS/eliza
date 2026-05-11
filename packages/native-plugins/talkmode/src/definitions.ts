import type { PluginListenerHandle } from "@capacitor/core";

/**
 * TTS voice directive from assistant response
 */
export interface TTSDirective {
  /** Voice ID to use (ElevenLabs voice ID or alias) */
  voiceId?: string;
  /** Model ID for ElevenLabs */
  modelId?: string;
  /** Output format (e.g., "pcm_24000", "mp3_44100") */
  outputFormat?: string;
  /** Speech rate multiplier (0.5-2.0) */
  speed?: number;
  /** Words per minute rate */
  rateWpm?: number;
  /** Voice stability (0-1) */
  stability?: number;
  /** Voice similarity boost (0-1) */
  similarity?: number;
  /** Style exaggeration (0-1) */
  style?: number;
  /** Enable speaker boost */
  speakerBoost?: boolean;
  /** Seed for reproducible output */
  seed?: number;
  /** Normalize audio levels */
  normalize?: boolean;
  /** Language code (e.g., "en", "es") */
  language?: string;
  /** Latency optimization tier (1-4) */
  latencyTier?: number;
  /** Apply only to this utterance */
  once?: boolean;
}

/**
 * TTS configuration
 */
export interface TTSConfig {
  /** Default ElevenLabs voice ID */
  voiceId?: string;
  /** Default ElevenLabs model ID */
  modelId?: string;
  /** Default output format */
  outputFormat?: string;
  /** ElevenLabs API key */
  apiKey?: string;
  /** Voice aliases mapping (name -> voiceId) */
  voiceAliases?: Record<string, string>;
  /** Whether to interrupt playback when user speaks */
  interruptOnSpeech?: boolean;
}

/**
 * Options for speaking text
 */
export interface SpeakOptions {
  /** Text to speak */
  text: string;
  /** Optional directive overrides */
  directive?: TTSDirective;
  /** Force use of system TTS */
  useSystemTts?: boolean;
}

/**
 * Result of speak operation
 */
export interface SpeakResult {
  /** Whether speech completed successfully */
  completed: boolean;
  /** Whether playback was interrupted */
  interrupted: boolean;
  /** Time at which playback was interrupted (seconds from start) */
  interruptedAt?: number;
  /** Whether system TTS was used as fallback */
  usedSystemTts: boolean;
  /** Error message if failed */
  error?: string;
}

export type TalkModeSessionMode =
  | "idle"
  | "compose"
  | "push-to-talk"
  | "hands-free"
  | "passive";

export interface TalkModeSpeakerMetadata {
  /** Stable app/runtime entity id for the speaker when available. */
  entityId?: string;
  /** Connector-native speaker id, such as a Discord user id. */
  sourceId?: string;
  /** Connector/source label, such as "discord", "web", or "native". */
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

export interface TalkModeVoiceTurn {
  /** Stable id for this captured speech turn when available. */
  id?: string;
  /** Transcript text for this turn. */
  text: string;
  /** Session mode that produced this turn. */
  mode: TalkModeSessionMode;
  /** Whether this turn is final. */
  isFinal: boolean;
  /** Speaker attribution when provided by the capture backend. */
  speaker?: TalkModeSpeakerMetadata;
  /** Capture backend/source label. */
  source?: string;
  /** Turn start timestamp in epoch milliseconds. */
  startedAtMs?: number;
  /** Turn end timestamp in epoch milliseconds. */
  endedAtMs?: number;
  /** STT confidence where available. */
  confidence?: number;
  /** Backend-specific metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Talk mode configuration
 */
export interface TalkModeConfig {
  /** Session mode requested by the UI/connector. */
  mode?: Exclude<TalkModeSessionMode, "idle">;
  /** Session key for chat */
  sessionKey?: string;
  /** TTS configuration */
  tts?: TTSConfig;
  /** STT configuration (desktop whisper/web) */
  stt?: {
    /** STT engine preference */
    engine?: "whisper" | "web";
    /** Whisper model size */
    modelSize?: "tiny" | "base" | "small" | "medium" | "large";
    /** Language code (e.g., "en", "es") */
    language?: string;
    /** Audio sample rate in Hz (default: 16000) */
    sampleRate?: number;
  };
  /** Silence window before finalizing transcript (ms) */
  silenceWindowMs?: number;
  /** Whether to use interrupt-on-speech */
  interruptOnSpeech?: boolean;
}

/**
 * Talk mode state
 */
export type TalkModeState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

/**
 * Talk mode state event
 */
export interface TalkModeStateEvent {
  /** Current state */
  state: TalkModeState;
  /** Previous state */
  previousState: TalkModeState;
  /** Current session mode */
  mode?: TalkModeSessionMode;
  /** Status message */
  statusText: string;
  /** Whether system TTS is being used */
  usingSystemTts?: boolean;
}

/**
 * Transcript event during talk mode
 */
export interface TalkModeTranscriptEvent {
  /** Transcript text */
  transcript: string;
  /** Whether this is final */
  isFinal: boolean;
  /** Session mode that produced this transcript */
  mode?: Exclude<TalkModeSessionMode, "idle">;
  /** Speaker attribution when provided by the capture backend */
  speaker?: TalkModeSpeakerMetadata;
  /** Full turn metadata for speaker-aware clients */
  turn?: TalkModeVoiceTurn;
  /** Capture backend/source label */
  source?: string;
  /** STT confidence where available */
  confidence?: number;
}

/**
 * TTS start event
 */
export interface TTSSpeakingEvent {
  /** Text being spoken */
  text: string;
  /** Whether using system TTS */
  isSystemTts: boolean;
}

/**
 * TTS completion event
 */
export interface TTSCompleteEvent {
  /** Whether completed without interruption */
  completed: boolean;
  /** Interrupted at time (seconds) if interrupted */
  interruptedAt?: number;
}

/**
 * Talk mode error event
 */
export interface TalkModeErrorEvent {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Whether recoverable */
  recoverable: boolean;
}

/**
 * Permission status for talk mode
 */
export interface TalkModePermissionStatus {
  /** Microphone permission */
  microphone: "granted" | "denied" | "prompt";
  /** Speech recognition permission */
  speechRecognition: "granted" | "denied" | "prompt" | "not_supported";
}

/**
 * TalkMode Plugin Interface
 *
 * Provides full conversation mode with STT → chat → TTS flow.
 * Uses ElevenLabs for high-quality TTS with system TTS fallback.
 */
export interface TalkModePlugin {
  /**
   * Start talk mode
   *
   * @param options - Configuration options
   * @returns Promise resolving when started
   */
  start(options?: {
    config?: TalkModeConfig;
  }): Promise<{ started: boolean; error?: string }>;

  /**
   * Stop talk mode
   *
   * @returns Promise that resolves when stopped
   */
  stop(): Promise<void>;

  /**
   * Check if talk mode is enabled
   *
   * @returns Promise resolving to enabled status
   */
  isEnabled(): Promise<{ enabled: boolean }>;

  /**
   * Get current state
   *
   * @returns Promise resolving to current state
   */
  getState(): Promise<{ state: TalkModeState; statusText: string }>;

  /**
   * Update configuration
   *
   * @param options - New configuration
   * @returns Promise that resolves when updated
   */
  updateConfig(options: { config: Partial<TalkModeConfig> }): Promise<void>;

  /**
   * Speak text using TTS
   *
   * @param options - Text and options
   * @returns Promise resolving to speak result
   */
  speak(options: SpeakOptions): Promise<SpeakResult>;

  /**
   * Stop current TTS playback
   *
   * @returns Promise that resolves when stopped
   */
  stopSpeaking(): Promise<{ interruptedAt?: number }>;

  /**
   * Check if currently speaking
   *
   * @returns Promise resolving to speaking status
   */
  isSpeaking(): Promise<{ speaking: boolean }>;

  /**
   * Check permissions
   *
   * @returns Promise resolving to permission status
   */
  checkPermissions(): Promise<TalkModePermissionStatus>;

  /**
   * Request permissions
   *
   * @returns Promise resolving to permission status after request
   */
  requestPermissions(): Promise<TalkModePermissionStatus>;

  /**
   * Add listener for state changes
   */
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: TalkModeStateEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for transcript updates during listening
   */
  addListener(
    eventName: "transcript",
    listenerFunc: (event: TalkModeTranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for TTS start
   */
  addListener(
    eventName: "speaking",
    listenerFunc: (event: TTSSpeakingEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for TTS completion
   */
  addListener(
    eventName: "speakComplete",
    listenerFunc: (event: TTSCompleteEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for errors
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: TalkModeErrorEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all listeners
   */
  removeAllListeners(): Promise<void>;
}
