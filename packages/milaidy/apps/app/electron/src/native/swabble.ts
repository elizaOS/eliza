/**
 * Swabble Native Module for Electron
 *
 * Wake word detection and speech-to-text using Whisper.cpp
 * with full word-level timing for postGap analysis.
 */

import { EventEmitter } from "events";
import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { WhisperSTT, WhisperStreamTranscriber, WhisperResult, WhisperSegment } from "./whisper";
import type { IpcValue } from "./ipc-types";

// Types
export interface SwabbleConfig {
  triggers: string[];
  minPostTriggerGap?: number; // seconds
  minCommandLength?: number;
  locale?: string;
  modelSize?: "tiny" | "base" | "small" | "medium" | "large";
}

export interface SpeechSegment {
  text: string;
  start: number; // milliseconds
  duration: number; // milliseconds
  isFinal: boolean;
}

export interface WakeWordEvent {
  wakeWord: string;
  command: string;
  transcript: string;
  postGap: number; // seconds, -1 if unavailable
  confidence?: number;
}

export interface TranscriptEvent {
  transcript: string;
  segments: SpeechSegment[];
  isFinal: boolean;
  confidence?: number;
}

/**
 * Wake Word Gate with timing-based detection
 */
class WakeWordGate {
  private triggers: string[];
  private minPostTriggerGap: number;
  private minCommandLength: number;

  constructor(config: SwabbleConfig) {
    this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
    this.minPostTriggerGap = config.minPostTriggerGap ?? 0.45;
    this.minCommandLength = config.minCommandLength ?? 1;
  }

  updateConfig(config: Partial<SwabbleConfig>): void {
    if (config.triggers) {
      this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
    }
    if (config.minPostTriggerGap !== undefined) {
      this.minPostTriggerGap = config.minPostTriggerGap;
    }
    if (config.minCommandLength !== undefined) {
      this.minCommandLength = config.minCommandLength;
    }
  }

  /**
   * Match wake word in Whisper result using timing data
   */
  match(result: WhisperResult): WakeWordEvent | null {
    const segments = result.segments;
    if (segments.length === 0) return null;

    // Build word list with timing
    const words: Array<{ text: string; start: number; end: number }> = [];
    for (const segment of segments) {
      if (segment.tokens) {
        // Use token-level timing if available
        for (const token of segment.tokens) {
          const text = token.text.trim().toLowerCase();
          if (text) {
            words.push({ text, start: token.start, end: token.end });
          }
        }
      } else {
        // Fall back to segment-level timing
        const segWords = segment.text.split(/\s+/).filter((w) => w.trim());
        const duration = segment.end - segment.start;
        const wordDuration = duration / Math.max(segWords.length, 1);

        for (let i = 0; i < segWords.length; i++) {
          words.push({
            text: segWords[i].toLowerCase(),
            start: segment.start + i * wordDuration,
            end: segment.start + (i + 1) * wordDuration,
          });
        }
      }
    }

    // Find trigger phrase in words
    for (const trigger of this.triggers) {
      const triggerWords = trigger.split(/\s+/);
      const triggerMatch = this.findTriggerMatch(words, triggerWords);

      if (triggerMatch) {
        const { triggerEndIndex, triggerEndTime } = triggerMatch;

        // Check for command words after trigger
        const commandWords = words.slice(triggerEndIndex + 1);
        if (commandWords.length < this.minCommandLength) continue;

        // Calculate post-trigger gap
        const firstCommandTime = commandWords[0].start;
        const postGap = (firstCommandTime - triggerEndTime) / 1000; // Convert to seconds

        // Check if gap meets minimum requirement
        if (postGap < this.minPostTriggerGap) continue;

        const command = commandWords.map((w) => w.text).join(" ");

        return {
          wakeWord: trigger,
          command,
          transcript: result.text,
          postGap,
        };
      }
    }

    return null;
  }

  private findTriggerMatch(
    words: Array<{ text: string; start: number; end: number }>,
    triggerWords: string[]
  ): { triggerEndIndex: number; triggerEndTime: number } | null {
    for (let i = 0; i <= words.length - triggerWords.length; i++) {
      let matches = true;
      for (let j = 0; j < triggerWords.length; j++) {
        if (!this.fuzzyMatch(words[i + j].text, triggerWords[j])) {
          matches = false;
          break;
        }
      }

      if (matches) {
        const endIndex = i + triggerWords.length - 1;
        return {
          triggerEndIndex: endIndex,
          triggerEndTime: words[endIndex].end,
        };
      }
    }

    return null;
  }

  private fuzzyMatch(word: string, target: string): boolean {
    // Exact match
    if (word === target) return true;

    // Allow for common transcription variations
    const variations: Record<string, string[]> = {
      claude: ["claud", "cloud", "clawed", "clawd"],
      alexa: ["alexia", "alexis"],
      hey: ["hay", "hi"],
      ok: ["okay", "o.k."],
    };

    const targetVariations = variations[target] || [];
    return targetVariations.includes(word);
  }
}

/**
 * Swabble Manager - Wake word detection with Whisper
 */
export class SwabbleManager extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private config: SwabbleConfig | null = null;
  private wakeGate: WakeWordGate | null = null;

  private whisper: WhisperSTT | null = null;
  private whisperStream: WhisperStreamTranscriber | null = null;
  private isActive = false;

  constructor() {
    super();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Start wake word detection
   */
  async start(options: { config: SwabbleConfig }): Promise<{ started: boolean; error?: string }> {
    if (this.isActive) {
      return { started: true };
    }

    this.config = options.config;
    this.wakeGate = new WakeWordGate(options.config);

    // Initialize Whisper
    try {
      this.whisper = new WhisperSTT({
        modelSize: options.config.modelSize || "base",
        language: options.config.locale?.split("-")[0] || "en",
      });

      const initialized = await this.whisper.initialize();
      if (!initialized) {
        return {
          started: false,
          error: "Whisper not available. Install whisper-node and download a model for offline wake word detection.",
        };
      }

      this.whisperStream = new WhisperStreamTranscriber(this.whisper);
      this.setupWhisperListeners();

      await this.whisperStream.start();
      this.isActive = true;

      this.sendToRenderer("swabble:stateChange", { state: "listening" });
      return { started: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Swabble";
      return { started: false, error: message };
    }
  }

  private setupWhisperListeners(): void {
    if (!this.whisperStream) return;

    this.whisperStream.on("transcript", (result: WhisperResult) => {
      // Convert to our segment format
      const segments: SpeechSegment[] = result.segments.map((seg: WhisperSegment) => ({
        text: seg.text,
        start: seg.start / 1000,
        duration: (seg.end - seg.start) / 1000,
        isFinal: true,
      }));

      // Send transcript event
      this.sendToRenderer("swabble:transcript", {
        transcript: result.text,
        segments,
        isFinal: true,
      });

      this.emit("transcript", {
        transcript: result.text,
        segments,
        isFinal: true,
      });

      // Check for wake word
      if (this.wakeGate) {
        const match = this.wakeGate.match(result);
        if (match) {
          this.sendToRenderer("swabble:wakeWord", match);
          this.emit("wakeWord", match);
        }
      }
    });

    this.whisperStream.on("started", () => {
      this.sendToRenderer("swabble:stateChange", { state: "listening" });
    });

    this.whisperStream.on("stopped", () => {
      this.sendToRenderer("swabble:stateChange", { state: "idle" });
    });
  }

  /**
   * Stop wake word detection
   */
  async stop(): Promise<void> {
    this.isActive = false;

    if (this.whisperStream) {
      this.whisperStream.stop();
      this.whisperStream.dispose();
      this.whisperStream = null;
    }

    if (this.whisper) {
      this.whisper.dispose();
      this.whisper = null;
    }

    this.sendToRenderer("swabble:stateChange", { state: "idle" });
  }

  /**
   * Check if listening
   */
  isListening(): boolean {
    return this.isActive;
  }

  /**
   * Get current config
   */
  getConfig(): SwabbleConfig | null {
    return this.config;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SwabbleConfig>): void {
    if (this.config) {
      this.config = { ...this.config, ...config };
      this.wakeGate?.updateConfig(config);
    }
  }

  /**
   * Check if Whisper is available
   */
  isWhisperAvailable(): boolean {
    return this.whisper !== null;
  }

  feedAudio(samples: Float32Array): void {
    if (this.whisperStream && this.isActive) {
      this.whisperStream.feedAudio(samples);
    }
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
let swabbleManager: SwabbleManager | null = null;

export function getSwabbleManager(): SwabbleManager {
  if (!swabbleManager) {
    swabbleManager = new SwabbleManager();
  }
  return swabbleManager;
}

/**
 * Register Swabble IPC handlers
 */
export function registerSwabbleIPC(): void {
  const manager = getSwabbleManager();

  ipcMain.handle("swabble:start", async (_e: IpcMainInvokeEvent, options: { config: SwabbleConfig }) => {
    return manager.start(options);
  });

  ipcMain.handle("swabble:stop", async () => {
    return manager.stop();
  });

  ipcMain.handle("swabble:isListening", () => {
    return { listening: manager.isListening() };
  });

  ipcMain.handle("swabble:getConfig", () => {
    return { config: manager.getConfig() };
  });

  ipcMain.handle("swabble:updateConfig", (_e: IpcMainInvokeEvent, options: { config: Partial<SwabbleConfig> }) => {
    return manager.updateConfig(options.config);
  });

  ipcMain.handle("swabble:isWhisperAvailable", () => {
    return { available: manager.isWhisperAvailable() };
  });

  ipcMain.on("swabble:audioChunk", (_e: IpcMainEvent, payload: ArrayBuffer | Float32Array) => {
    const samples = payload instanceof Float32Array ? payload : new Float32Array(payload);
    manager.feedAudio(samples);
  });
}
