/**
 * Whisper.cpp Native Module for Electron
 *
 * Provides offline speech-to-text with word-level timing data using whisper.cpp
 * via Node.js native bindings (whisper-node or similar).
 *
 * Features:
 * - Offline STT (no internet required)
 * - Word-level timestamps for wake word detection gap analysis
 * - Multiple model sizes (tiny, base, small, medium, large)
 * - Multilingual support
 */

import { EventEmitter } from "events";
import path from "path";
import fs from "fs";
import { app } from "electron";

// Types for whisper.cpp integration
export interface WhisperConfig {
  modelPath?: string;
  modelSize?: "tiny" | "base" | "small" | "medium" | "large";
  language?: string;
  translate?: boolean;
  threads?: number;
  speedUp?: boolean;
  diarize?: boolean;
}

export interface WhisperSegment {
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
  tokens?: WhisperToken[];
}

export interface WhisperToken {
  text: string;
  start: number;
  end: number;
  probability: number;
}

export interface WhisperResult {
  text: string;
  segments: WhisperSegment[];
  language: string;
  duration: number;
}

// Try to load whisper bindings dynamically
let whisperModule: WhisperBindings | null = null;

interface WhisperInitOptions {
  language?: string;
  translate?: boolean;
  threads?: number;
  speed_up?: boolean;
  diarize?: boolean;
}

interface WhisperTranscribeOptions {
  token_timestamps?: boolean;
  word_timestamps?: boolean;
}

interface WhisperBindings {
  init(modelPath: string, options?: WhisperInitOptions): Promise<WhisperContext>;
}

interface WhisperContext {
  transcribe(audioPath: string, options?: WhisperTranscribeOptions): Promise<WhisperNativeResult>;
  transcribeBuffer(buffer: Float32Array, options?: WhisperTranscribeOptions): Promise<WhisperNativeResult>;
  free(): void;
}

interface WhisperNativeResult {
  text: string;
  segments: Array<{
    text: string;
    t0: number;
    t1: number;
    tokens?: Array<{
      text: string;
      t0: number;
      t1: number;
      p: number;
    }>;
  }>;
  language?: string;
}

interface WhisperBindingsModule {
  default?: WhisperBindings;
  init?: WhisperBindings["init"];
}

async function loadWhisperModule(): Promise<WhisperBindings | null> {
  // Try different whisper binding packages
  const packages = [
    "whisper-node",
    "@nicksellen/whisper-node",
    "whisper.cpp",
    "@nicksellen/whispercpp",
  ];

  for (const pkg of packages) {
    try {
      // Dynamic import for native module
      const mod = (await import(pkg)) as WhisperBindingsModule;
      const bindings = mod.default ?? mod;
      if (bindings?.init) {
        console.log(`[Whisper] Loaded bindings from ${pkg}`);
        return bindings;
      }
      console.log(`[Whisper] Package ${pkg} loaded but has no init function`);
    } catch (err) {
      // Expected for packages that aren't installed - only log at debug level
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Cannot find module") && !message.includes("MODULE_NOT_FOUND")) {
        console.warn(`[Whisper] Failed to load ${pkg}:`, message);
      }
    }
  }

  console.warn("[Whisper] No whisper.cpp bindings found. Install whisper-node for offline STT.");
  return null;
}

/**
 * WhisperSTT - Offline speech-to-text engine
 */
export class WhisperSTT extends EventEmitter {
  private context: WhisperContext | null = null;
  private config: WhisperConfig;
  private isInitialized = false;
  private isProcessing = false;

  constructor(config: WhisperConfig = {}) {
    super();
    this.config = {
      modelSize: "base",
      language: "en",
      threads: 4,
      ...config,
    };
  }

  /**
   * Initialize Whisper with the specified model
   */
  async initialize(): Promise<boolean> {
    if (this.isInitialized) return true;

    if (!whisperModule) {
      whisperModule = await loadWhisperModule();
    }

    if (!whisperModule) {
      this.emit("error", { message: "Whisper bindings not available" });
      return false;
    }

    const modelPath = this.getModelPath();
    if (!modelPath || !fs.existsSync(modelPath)) {
      this.emit("error", { message: `Model not found: ${modelPath}` });
      return false;
    }

    try {
      this.context = await whisperModule.init(modelPath, {
        language: this.config.language,
        translate: this.config.translate,
        threads: this.config.threads,
        speed_up: this.config.speedUp,
      });
      this.isInitialized = true;
      this.emit("initialized");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to initialize Whisper";
      this.emit("error", { message });
      return false;
    }
  }

  /**
   * Get the model file path
   */
  private getModelPath(): string | null {
    if (this.config.modelPath) {
      return this.config.modelPath;
    }

    const modelName = `ggml-${this.config.modelSize}.bin`;
    const possiblePaths = [
      // App resources
      path.join(app.getAppPath(), "models", modelName),
      // User data directory
      path.join(app.getPath("userData"), "models", modelName),
      // Common system locations
      path.join(process.env.HOME || "", ".cache", "whisper", modelName),
      path.join("/usr/local/share/whisper", modelName),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return possiblePaths[1]; // Default to userData path
  }

  /**
   * Get the path where models should be downloaded
   */
  getModelsDirectory(): string {
    return path.join(app.getPath("userData"), "models");
  }

  /**
   * Check if a model is available
   */
  isModelAvailable(size?: string): boolean {
    const modelName = `ggml-${size || this.config.modelSize}.bin`;
    const modelPath = path.join(this.getModelsDirectory(), modelName);
    return fs.existsSync(modelPath);
  }

  /**
   * Transcribe an audio file
   */
  async transcribeFile(audioPath: string): Promise<WhisperResult | null> {
    if (!this.context) {
      const initialized = await this.initialize();
      if (!initialized) return null;
    }

    if (this.isProcessing) {
      return null;
    }

    this.isProcessing = true;
    this.emit("processing", { path: audioPath });

    try {
      const result = await this.context!.transcribe(audioPath, {
        token_timestamps: true,
        word_timestamps: true,
      });

      const whisperResult = this.convertResult(result);
      this.emit("result", whisperResult);
      return whisperResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      this.emit("error", { message });
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Transcribe audio from a Float32Array buffer (16kHz mono PCM)
   */
  async transcribeBuffer(audioBuffer: Float32Array): Promise<WhisperResult | null> {
    if (!this.context) {
      const initialized = await this.initialize();
      if (!initialized) return null;
    }

    if (this.isProcessing) {
      return null;
    }

    this.isProcessing = true;
    this.emit("processing", { bufferLength: audioBuffer.length });

    try {
      const result = await this.context!.transcribeBuffer(audioBuffer, {
        token_timestamps: true,
        word_timestamps: true,
      });

      const whisperResult = this.convertResult(result);
      this.emit("result", whisperResult);
      return whisperResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      this.emit("error", { message });
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Convert native result to our format
   */
  private convertResult(native: WhisperNativeResult): WhisperResult {
    const segments: WhisperSegment[] = native.segments.map((seg) => ({
      text: seg.text.trim(),
      start: seg.t0,
      end: seg.t1,
      tokens: seg.tokens?.map((tok) => ({
        text: tok.text,
        start: tok.t0,
        end: tok.t1,
        probability: tok.p,
      })),
    }));

    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

    return {
      text: native.text.trim(),
      segments,
      language: native.language || this.config.language || "en",
      duration,
    };
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.context) {
      this.context.free();
      this.context = null;
    }
    this.isInitialized = false;
    this.removeAllListeners();
  }
}

/**
 * Configuration for VAD (Voice Activity Detection) in stream transcription
 */
export interface VADConfig {
  /** Minimum audio chunk duration in seconds before processing (default: 1.0) */
  minChunkDuration?: number;
  /** Maximum audio chunk duration in seconds (default: 30.0) */
  maxChunkDuration?: number;
  /** Audio level threshold for voice detection (default: 0.01) */
  silenceThreshold?: number;
  /** Seconds of silence to trigger transcription (default: 0.5) */
  silenceDuration?: number;
  /** Audio sample rate in Hz (default: 16000) */
  sampleRate?: number;
}

/**
 * Continuous audio stream transcription using Whisper
 */
export class WhisperStreamTranscriber extends EventEmitter {
  private whisper: WhisperSTT;
  private audioBuffer: Float32Array;
  private bufferPosition = 0;
  private sampleRate: number;
  private minChunkDuration: number;
  private maxChunkDuration: number;
  private silenceThreshold: number;
  private silenceDuration: number;
  private lastActiveTime = 0;
  private isListening = false;
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(whisper: WhisperSTT, config?: VADConfig) {
    super();
    this.whisper = whisper;

    // Apply defaults, allowing per-instance configuration
    this.sampleRate = config?.sampleRate ?? 16000;
    this.minChunkDuration = config?.minChunkDuration ?? 1.0;
    this.maxChunkDuration = config?.maxChunkDuration ?? 30.0;
    this.silenceThreshold = config?.silenceThreshold ?? 0.01;
    this.silenceDuration = config?.silenceDuration ?? 0.5;

    this.audioBuffer = new Float32Array(this.sampleRate * this.maxChunkDuration);
  }

  /**
   * Start continuous listening
   */
  async start(): Promise<void> {
    if (this.isListening) return;

    const initialized = await this.whisper.initialize();
    if (!initialized) {
      throw new Error("Failed to initialize Whisper");
    }

    this.isListening = true;
    this.bufferPosition = 0;
    this.lastActiveTime = Date.now();

    // Check for silence periodically
    this.processingInterval = setInterval(() => {
      this.checkAndProcess();
    }, 200);

    this.emit("started");
  }

  /**
   * Stop listening
   */
  stop(): void {
    this.isListening = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Process any remaining audio
    if (this.bufferPosition > this.sampleRate * this.minChunkDuration) {
      this.processCurrentBuffer().catch((err) => {
        console.error("[Whisper] Error processing final buffer on stop:", err);
        this.emit("error", { message: err instanceof Error ? err.message : "Final buffer processing failed" });
      });
    }

    this.emit("stopped");
  }

  /**
   * Feed audio samples (Float32Array, 16kHz mono)
   */
  feedAudio(samples: Float32Array): void {
    if (!this.isListening) return;

    // Check for voice activity
    let maxLevel = 0;
    for (const sample of samples) {
      maxLevel = Math.max(maxLevel, Math.abs(sample));
    }

    if (maxLevel > this.silenceThreshold) {
      this.lastActiveTime = Date.now();
    }

    // Add to buffer
    const remaining = this.audioBuffer.length - this.bufferPosition;
    const toCopy = Math.min(samples.length, remaining);
    this.audioBuffer.set(samples.subarray(0, toCopy), this.bufferPosition);
    this.bufferPosition += toCopy;

    // If buffer is full, process immediately
    if (this.bufferPosition >= this.audioBuffer.length) {
      this.processCurrentBuffer().catch((err) => {
        console.error("[Whisper] Error processing full buffer:", err);
        this.emit("error", { message: err instanceof Error ? err.message : "Buffer processing failed" });
      });
    }
  }

  /**
   * Check if we should process based on silence detection
   */
  private checkAndProcess(): void {
    if (!this.isListening) return;

    const timeSinceActive = (Date.now() - this.lastActiveTime) / 1000;
    const bufferDuration = this.bufferPosition / this.sampleRate;

    // Process if we have enough audio and detected silence
    if (bufferDuration >= this.minChunkDuration && timeSinceActive >= this.silenceDuration) {
      this.processCurrentBuffer().catch((err) => {
        console.error("[Whisper] Error processing buffer on silence detection:", err);
        this.emit("error", { message: err instanceof Error ? err.message : "Silence-triggered processing failed" });
      });
    }
  }

  /**
   * Process the current audio buffer
   */
  private async processCurrentBuffer(): Promise<void> {
    if (this.bufferPosition === 0) return;

    const chunk = this.audioBuffer.slice(0, this.bufferPosition);
    this.bufferPosition = 0;

    const result = await this.whisper.transcribeBuffer(chunk);
    if (result && result.text.trim()) {
      this.emit("transcript", result);
    }
  }

  /**
   * Clean up
   */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}

// Export singleton for easy use
let defaultWhisper: WhisperSTT | null = null;

export function getWhisperInstance(config?: WhisperConfig): WhisperSTT {
  if (!defaultWhisper) {
    defaultWhisper = new WhisperSTT(config);
  }
  return defaultWhisper;
}

export function disposeWhisperInstance(): void {
  if (defaultWhisper) {
    defaultWhisper.dispose();
    defaultWhisper = null;
  }
}
