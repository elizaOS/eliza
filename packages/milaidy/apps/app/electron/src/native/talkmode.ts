/**
 * TalkMode Native Module for Electron
 *
 * Provides full conversation mode with:
 * - Whisper.cpp STT (offline, word-level timing)
 * - ElevenLabs TTS streaming (high quality)
 * - Renderer audio capture via IPC (Whisper)
 */

import { EventEmitter } from "events";
import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { WhisperSTT, WhisperStreamTranscriber, WhisperResult } from "./whisper";
import https from "https";
import type { IpcValue } from "./ipc-types";

// Types
export interface TalkModeConfig {
  stt?: {
    engine?: "whisper" | "web";
    modelSize?: "tiny" | "base" | "small" | "medium" | "large";
    language?: string;
  };
  tts?: {
    engine?: "elevenlabs" | "system";
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  vad?: {
    enabled?: boolean;
    silenceThreshold?: number;
    silenceDuration?: number;
  };
}

export interface TTSDirective {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarity?: number;
  speed?: number;
}

export interface SpeakOptions {
  text: string;
  directive?: TTSDirective;
  useSystemTts?: boolean;
}

export interface SpeakResult {
  completed: boolean;
  interrupted: boolean;
  usedSystemTts: boolean;
  error?: string;
}

type TalkModeState = "idle" | "listening" | "processing" | "speaking" | "error";

/**
 * ElevenLabs TTS streaming client
 */
class ElevenLabsTTS extends EventEmitter {
  private apiKey: string;
  private defaultVoiceId: string;
  private defaultModelId: string;
  private currentRequest: https.ClientRequest | null = null;

  constructor(apiKey: string, voiceId: string, modelId = "eleven_v3") {
    super();
    this.apiKey = apiKey;
    this.defaultVoiceId = voiceId;
    this.defaultModelId = modelId;
  }

  async speak(options: SpeakOptions): Promise<SpeakResult> {
    const text = options.text.trim();
    if (!text) {
      return { completed: true, interrupted: false, usedSystemTts: false };
    }

    const voiceId = options.directive?.voiceId || this.defaultVoiceId;
    const modelId = options.directive?.modelId || this.defaultModelId;

    return new Promise((resolve) => {
      this.emit("speaking", { text, isSystemTts: false });

      const postData = JSON.stringify({
        text,
        model_id: modelId,
        output_format: "mp3_44100_128",
        voice_settings: {
          stability: options.directive?.stability ?? 0.5,
          similarity_boost: options.directive?.similarity ?? 0.75,
          speed: options.directive?.speed ?? 1.0,
        },
      });

      const requestOptions = {
        hostname: "api.elevenlabs.io",
        port: 443,
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey,
          "Content-Length": Buffer.byteLength(postData),
        },
      };

      const audioChunks: Buffer[] = [];

      this.currentRequest = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          resolve({
            completed: false,
            interrupted: false,
            usedSystemTts: false,
            error: `ElevenLabs API error: ${res.statusCode}`,
          });
          return;
        }

        res.on("data", (chunk: Buffer) => {
          audioChunks.push(chunk);
          // Stream chunks to player as they arrive
          this.emit("audioChunk", chunk);
        });

        res.on("end", () => {
          const fullAudio = Buffer.concat(audioChunks);
          this.emit("audioComplete", fullAudio);
          this.emit("speakComplete", { completed: true });

          resolve({
            completed: true,
            interrupted: false,
            usedSystemTts: false,
          });
        });

        res.on("error", (error) => {
          resolve({
            completed: false,
            interrupted: false,
            usedSystemTts: false,
            error: error.message,
          });
        });
      });

      this.currentRequest.on("error", (error) => {
        resolve({
          completed: false,
          interrupted: false,
          usedSystemTts: false,
          error: error.message,
        });
      });

      this.currentRequest.write(postData);
      this.currentRequest.end();
    });
  }

  stop(): void {
    if (this.currentRequest) {
      this.currentRequest.destroy();
      this.currentRequest = null;
    }
  }

  updateConfig(apiKey?: string, voiceId?: string, modelId?: string): void {
    if (apiKey) this.apiKey = apiKey;
    if (voiceId) this.defaultVoiceId = voiceId;
    if (modelId) this.defaultModelId = modelId;
  }
}

/**
 * TalkMode Manager - orchestrates STT and TTS
 */
export class TalkModeManager extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private config: TalkModeConfig = {};
  private state: TalkModeState = "idle";
  private statusText = "Off";

  private whisper: WhisperSTT | null = null;
  private whisperStream: WhisperStreamTranscriber | null = null;
  private elevenLabs: ElevenLabsTTS | null = null;

  private isEnabled = false;
  private isSpeaking = false;

  constructor() {
    super();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Start TalkMode
   */
  async start(options?: { config?: TalkModeConfig }): Promise<{ started: boolean; error?: string }> {
    if (this.isEnabled) {
      return { started: true };
    }

    if (options?.config) {
      this.config = { ...this.config, ...options.config };
    }

    // Initialize Whisper STT
    const useWhisper = this.config.stt?.engine !== "web";
    if (useWhisper) {
      try {
        this.whisper = new WhisperSTT({
          modelSize: this.config.stt?.modelSize || "base",
          language: this.config.stt?.language || "en",
        });

        const initialized = await this.whisper.initialize();
        if (!initialized) {
          this.sendToRenderer("talkmode:error", {
            code: "whisper_unavailable",
            message: "Whisper not available. Renderer should use Web Speech API.",
            recoverable: true,
          });
        } else {
          this.whisperStream = new WhisperStreamTranscriber(this.whisper);
          this.setupWhisperListeners();
        }
      } catch (error) {
        console.warn("[TalkMode] Failed to initialize Whisper:", error);
        this.sendToRenderer("talkmode:error", {
          code: "whisper_init_failed",
          message: error instanceof Error ? error.message : "Whisper init failed",
          recoverable: true,
        });
      }
    }

    // Initialize ElevenLabs TTS
    if (this.config.tts?.apiKey && this.config.tts?.voiceId) {
      this.elevenLabs = new ElevenLabsTTS(
        this.config.tts.apiKey,
        this.config.tts.voiceId,
        this.config.tts.modelId
      );
      this.setupTTSListeners();
    }

    this.isEnabled = true;
    this.setState("listening", "Listening");

    // Start audio capture if we have Whisper
    if (this.whisperStream) {
      await this.whisperStream.start();
    }

    return { started: true };
  }

  private setupWhisperListeners(): void {
    if (!this.whisperStream) return;

    this.whisperStream.on("transcript", (result: WhisperResult) => {
      this.sendToRenderer("talkmode:transcript", {
        transcript: result.text,
        isFinal: true,
      });

      this.emit("transcript", {
        transcript: result.text,
        isFinal: true,
      });
    });

    this.whisperStream.on("started", () => {
      this.setState("listening", "Listening (Whisper)");
    });

    this.whisperStream.on("stopped", () => {
      if (this.state === "listening") {
        this.setState("idle", "Off");
      }
    });
  }

  private setupTTSListeners(): void {
    if (!this.elevenLabs) return;

    this.elevenLabs.on("speaking", (data: { text: string; isSystemTts: boolean }) => {
      this.isSpeaking = true;
      this.setState("speaking", "Speaking");
      this.sendToRenderer("talkmode:speaking", data);
    });

    this.elevenLabs.on("speakComplete", (data: { completed: boolean }) => {
      this.isSpeaking = false;
      this.setState("listening", "Listening");
      this.sendToRenderer("talkmode:speakComplete", data);
    });

    this.elevenLabs.on("audioChunk", (chunk: Buffer) => {
      // Send audio chunks to renderer for playback
      this.sendToRenderer("talkmode:audioChunk", {
        chunk: chunk.toString("base64"),
      });
    });

    this.elevenLabs.on("audioComplete", (audio: Buffer) => {
      this.sendToRenderer("talkmode:audioComplete", {
        audioBase64: audio.toString("base64"),
      });
    });
  }

  /**
   * Stop TalkMode
   */
  async stop(): Promise<void> {
    this.isEnabled = false;

    if (this.whisperStream) {
      this.whisperStream.stop();
      this.whisperStream.dispose();
      this.whisperStream = null;
    }

    if (this.whisper) {
      this.whisper.dispose();
      this.whisper = null;
    }

    if (this.elevenLabs) {
      this.elevenLabs.stop();
      this.elevenLabs = null;
    }

    this.setState("idle", "Off");
  }

  /**
   * Speak text using TTS
   */
  async speak(options: SpeakOptions): Promise<SpeakResult> {
    if (options.useSystemTts || !this.elevenLabs) {
      // Let renderer handle system TTS
      return {
        completed: false,
        interrupted: false,
        usedSystemTts: true,
        error: "Use renderer for system TTS",
      };
    }

    return this.elevenLabs.speak(options);
  }

  feedAudio(samples: Float32Array): void {
    if (this.whisperStream && this.state === "listening") {
      this.whisperStream.feedAudio(samples);
    }
  }

  /**
   * Stop speaking
   */
  async stopSpeaking(): Promise<{ interruptedAt?: number }> {
    if (this.elevenLabs) {
      this.elevenLabs.stop();
    }
    this.isSpeaking = false;
    return {};
  }

  /**
   * Check if currently speaking
   */
  isSpeakingNow(): boolean {
    return this.isSpeaking;
  }

  /**
   * Get current state
   */
  getState(): { state: TalkModeState; statusText: string } {
    return { state: this.state, statusText: this.statusText };
  }

  /**
   * Check if enabled
   */
  isEnabledNow(): boolean {
    return this.isEnabled;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TalkModeConfig>): void {
    this.config = { ...this.config, ...config };

    if (config.tts && this.elevenLabs) {
      this.elevenLabs.updateConfig(
        config.tts.apiKey,
        config.tts.voiceId,
        config.tts.modelId
      );
    }
  }

  /**
   * Check if Whisper is available
   */
  isWhisperAvailable(): boolean {
    return this.whisper !== null && this.whisperStream !== null;
  }

  /**
   * Get Whisper model info
   */
  getWhisperInfo(): {
    available: boolean;
    modelSize?: string;
    modelPath?: string;
  } {
    if (!this.whisper) {
      return { available: false };
    }

    return {
      available: true,
      modelSize: this.config.stt?.modelSize || "base",
    };
  }

  private setState(state: TalkModeState, statusText: string): void {
    const previousState = this.state;
    this.state = state;
    this.statusText = statusText;

    this.sendToRenderer("talkmode:stateChange", {
      state,
      previousState,
      statusText,
    });

    this.emit("stateChange", { state, previousState, statusText });
  }

  private sendToRenderer(channel: string, data: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
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

// Singleton instance
let talkModeManager: TalkModeManager | null = null;

export function getTalkModeManager(): TalkModeManager {
  if (!talkModeManager) {
    talkModeManager = new TalkModeManager();
  }
  return talkModeManager;
}

/**
 * Register TalkMode IPC handlers
 */
export function registerTalkModeIPC(): void {
  const manager = getTalkModeManager();

  ipcMain.handle("talkmode:start", async (_e: IpcMainInvokeEvent, options?: { config?: TalkModeConfig }) => {
    return manager.start(options);
  });

  ipcMain.handle("talkmode:stop", async () => {
    return manager.stop();
  });

  ipcMain.handle("talkmode:speak", async (_e: IpcMainInvokeEvent, options: SpeakOptions) => {
    return manager.speak(options);
  });

  ipcMain.handle("talkmode:stopSpeaking", async () => {
    return manager.stopSpeaking();
  });

  ipcMain.handle("talkmode:isSpeaking", () => {
    return { speaking: manager.isSpeakingNow() };
  });

  ipcMain.handle("talkmode:getState", () => {
    return manager.getState();
  });

  ipcMain.handle("talkmode:isEnabled", () => {
    return { enabled: manager.isEnabledNow() };
  });

  ipcMain.handle("talkmode:updateConfig", (_e: IpcMainInvokeEvent, options: { config: Partial<TalkModeConfig> }) => {
    return manager.updateConfig(options.config);
  });

  ipcMain.handle("talkmode:isWhisperAvailable", () => {
    return { available: manager.isWhisperAvailable() };
  });

  ipcMain.handle("talkmode:getWhisperInfo", () => {
    return manager.getWhisperInfo();
  });

  ipcMain.on("talkmode:audioChunk", (_e: IpcMainEvent, payload: ArrayBuffer | Float32Array) => {
    const samples = payload instanceof Float32Array ? payload : new Float32Array(payload);
    manager.feedAudio(samples);
  });
}
