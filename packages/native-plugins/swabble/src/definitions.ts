import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Configuration for voice wake detection
 */
export interface SwabbleConfig {
  /** Wake word triggers (e.g., ["eliza"]) */
  triggers: string[];
  /** Minimum gap after trigger before command starts (seconds) */
  minPostTriggerGap?: number;
  /** Minimum command length in characters */
  minCommandLength?: number;
  /** Locale identifier for speech recognition (e.g., "en-US") */
  locale?: string;
  /** Audio sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** Whisper.cpp model size for desktop (optional) */
  modelSize?: "tiny" | "base" | "small" | "medium" | "large";
}

/**
 * Options for starting voice wake detection
 */
export interface SwabbleStartOptions {
  /** Configuration for wake word detection */
  config: SwabbleConfig;
}

/**
 * Result of starting voice wake detection
 */
export interface SwabbleStartResult {
  /** Whether voice wake started successfully */
  started: boolean;
  /** Error message if start failed */
  error?: string;
}

/**
 * Wake word detection event
 */
export interface SwabbleWakeWordEvent {
  /** The detected wake word */
  wakeWord: string;
  /** The command text following the wake word */
  command: string;
  /** Full transcript text */
  transcript: string;
  /** Time gap between wake word and command start */
  postGap: number;
  /** Confidence score (0-1) if available */
  confidence?: number;
}

/**
 * Speech segment with timing information
 */
export interface SwabbleSpeechSegment {
  /** Segment text */
  text: string;
  /** Start time in seconds from audio start */
  start: number;
  /** Duration in seconds */
  duration: number;
  /** Whether this is a final (non-partial) result */
  isFinal: boolean;
}

/**
 * Transcript event with full text and segments
 */
export interface SwabbleTranscriptEvent {
  /** Full transcript text */
  transcript: string;
  /** Individual speech segments with timing */
  segments: SwabbleSpeechSegment[];
  /** Whether this is a final (non-partial) result */
  isFinal: boolean;
  /** Confidence score (0-1) if available */
  confidence?: number;
}

/**
 * Voice wake state change event
 */
export interface SwabbleStateEvent {
  /** Current state */
  state: "idle" | "listening" | "processing" | "error";
  /** Reason for state change */
  reason?: string;
}

/**
 * Audio level event for visualization
 */
export interface SwabbleAudioLevelEvent {
  /** Audio level (0-1) */
  level: number;
  /** Peak level since last event */
  peak: number;
}

/**
 * Error event
 */
export interface SwabbleErrorEvent {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Whether the system will attempt to recover */
  recoverable: boolean;
}

/**
 * Permission status
 */
export interface SwabblePermissionStatus {
  /** Microphone permission status */
  microphone: "granted" | "denied" | "prompt";
  /** Speech recognition permission status */
  speechRecognition: "granted" | "denied" | "prompt" | "not_supported";
}

/**
 * Swabble Plugin Interface
 *
 * Provides voice wake word detection and speech-to-text capabilities.
 * Uses native Speech framework on iOS/macOS, SpeechRecognizer on Android,
 * and Whisper.cpp on desktop (Linux/Windows via Electrobun).
 */
export interface SwabblePlugin {
  /**
   * Start voice wake detection
   *
   * @param options - Configuration options
   * @returns Promise resolving to start result
   */
  start(options: SwabbleStartOptions): Promise<SwabbleStartResult>;

  /**
   * Stop voice wake detection
   *
   * @returns Promise that resolves when stopped
   */
  stop(): Promise<void>;

  /**
   * Check if voice wake is currently active
   *
   * @returns Promise resolving to active status
   */
  isListening(): Promise<{ listening: boolean }>;

  /**
   * Get current configuration
   *
   * @returns Promise resolving to current config
   */
  getConfig(): Promise<{ config: SwabbleConfig | null }>;

  /**
   * Update configuration while running
   *
   * @param options - New configuration
   * @returns Promise that resolves when updated
   */
  updateConfig(options: { config: Partial<SwabbleConfig> }): Promise<void>;

  /**
   * Check permission status
   *
   * @returns Promise resolving to permission status
   */
  checkPermissions(): Promise<SwabblePermissionStatus>;

  /**
   * Request required permissions
   *
   * @returns Promise resolving to permission status after request
   */
  requestPermissions(): Promise<SwabblePermissionStatus>;

  /**
   * Get list of available audio input devices
   *
   * @returns Promise resolving to device list
   */
  getAudioDevices(): Promise<{
    devices: Array<{ id: string; name: string; isDefault: boolean }>;
  }>;

  /**
   * Set the audio input device
   *
   * @param options - Device ID to use
   * @returns Promise that resolves when set
   */
  setAudioDevice(options: { deviceId: string }): Promise<void>;

  /**
   * Add a listener for wake word detection
   */
  addListener(
    eventName: "wakeWord",
    listenerFunc: (event: SwabbleWakeWordEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for transcript updates
   */
  addListener(
    eventName: "transcript",
    listenerFunc: (event: SwabbleTranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for state changes
   */
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: SwabbleStateEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for audio level updates
   */
  addListener(
    eventName: "audioLevel",
    listenerFunc: (event: SwabbleAudioLevelEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for errors
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: SwabbleErrorEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all listeners
   */
  removeAllListeners(): Promise<void>;
}
