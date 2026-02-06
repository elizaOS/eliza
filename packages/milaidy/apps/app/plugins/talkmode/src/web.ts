import { WebPlugin } from "@capacitor/core";
import type {
  TalkModeConfig,
  TalkModeState,
  TalkModePermissionStatus,
  SpeakOptions,
  SpeakResult,
} from "./definitions";

/** Minimal interface for the SpeechRecognition instance used by TalkMode */
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: SpeechRecognitionInstance) => void) | null;
  onend: ((this: SpeechRecognitionInstance) => void) | null;
  onerror: ((this: SpeechRecognitionInstance, event: { error: string; message?: string }) => void) | null;
  onresult: ((this: SpeechRecognitionInstance, event: SpeechRecognitionResultEvent) => void) | null;
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
  [index: number]: { isFinal: boolean; 0: { transcript: string; confidence: number } };
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

/**
 * Web implementation of TalkMode plugin
 *
 * Uses Web Speech API for TTS with limited functionality compared to native.
 * ElevenLabs streaming is not supported on web due to CORS limitations.
 */
export class TalkModeWeb extends WebPlugin {
  private config: TalkModeConfig = {};
  private state: TalkModeState = "idle";
  private statusText = "Off";
  private synthesis: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private recognition: SpeechRecognitionInstance | null = null;
  private enabled = false;

  constructor() {
    super();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.synthesis = window.speechSynthesis;
    }
  }

  async start(options?: { config?: TalkModeConfig }): Promise<{ started: boolean; error?: string }> {
    if (options?.config) {
      this.config = { ...this.config, ...options.config };
    }

    // Check for Web Speech API support
    const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
      (window as unknown as Record<string, unknown>).SpeechRecognition as SpeechRecognitionCtor | undefined ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition as SpeechRecognitionCtor | undefined;

    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error: "Speech recognition not supported on this browser",
      };
    }

    if (!this.synthesis) {
      console.warn("[TalkMode] Speech synthesis not available on web");
    }

    this.enabled = true;
    this.setState("listening", "Listening");

    // Initialize speech recognition
    this.recognition = new SpeechRecognitionAPI();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;

    this.recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0].transcript;
      const isFinal = result.isFinal;

      this.notifyListeners("transcript", { transcript, isFinal });

      if (isFinal && transcript.trim()) {
        // Note: Full talk mode flow would need Gateway plugin integration
        // For web, we just emit the transcript
      }
    };

    this.recognition.onerror = (event: { error: string; message?: string }) => {
      this.notifyListeners("error", {
        code: event.error,
        message: event.message || event.error,
        recoverable: event.error !== "not-allowed",
      });
    };

    this.recognition.onend = () => {
      if (this.enabled && this.state === "listening") {
        // Restart recognition if still enabled
        try {
          this.recognition?.start();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("already started")) {
            console.warn("[TalkMode] Failed to restart recognition:", msg);
          }
        }
      }
    };

    try {
      this.recognition.start();
      return { started: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start";
      return { started: false, error: message };
    }
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.recognition?.stop();
    this.recognition = null;
    this.synthesis?.cancel();
    this.currentUtterance = null;
    this.setState("idle", "Off");
  }

  async isEnabled(): Promise<{ enabled: boolean }> {
    return { enabled: this.enabled };
  }

  async getState(): Promise<{ state: TalkModeState; statusText: string }> {
    return { state: this.state, statusText: this.statusText };
  }

  async updateConfig(options: { config: Partial<TalkModeConfig> }): Promise<void> {
    this.config = { ...this.config, ...options.config };
  }

  async speak(options: SpeakOptions): Promise<SpeakResult> {
    if (!this.synthesis) {
      return {
        completed: false,
        interrupted: false,
        usedSystemTts: false,
        error: "Speech synthesis not available",
      };
    }

    // Web can only use system TTS (no ElevenLabs due to CORS)
    const text = options.text.trim();
    if (!text) {
      return { completed: true, interrupted: false, usedSystemTts: true };
    }

    this.setState("speaking", "Speaking");
    this.notifyListeners("speaking", { text, isSystemTts: true });

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      this.currentUtterance = utterance;

      // Apply directive settings if available
      if (options.directive?.speed) {
        utterance.rate = options.directive.speed;
      }
      if (options.directive?.language) {
        utterance.lang = options.directive.language;
      }

      utterance.onend = () => {
        this.currentUtterance = null;
        this.notifyListeners("speakComplete", { completed: true });
        this.setState("listening", "Listening");
        resolve({ completed: true, interrupted: false, usedSystemTts: true });
      };

      utterance.onerror = (event) => {
        this.currentUtterance = null;
        this.notifyListeners("speakComplete", { completed: false });
        this.setState("idle", "Speech error");
        resolve({
          completed: false,
          interrupted: event.error === "interrupted",
          usedSystemTts: true,
          error: event.error,
        });
      };

      this.synthesis!.speak(utterance);
    });
  }

  async stopSpeaking(): Promise<{ interruptedAt?: number }> {
    if (this.synthesis && this.currentUtterance) {
      this.synthesis.cancel();
      this.currentUtterance = null;
      return { interruptedAt: undefined };
    }
    return {};
  }

  async isSpeaking(): Promise<{ speaking: boolean }> {
    return { speaking: this.synthesis?.speaking ?? false };
  }

  async checkPermissions(): Promise<TalkModePermissionStatus> {
    // Check microphone permission
    let microphone: TalkModePermissionStatus["microphone"] = "prompt";
    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      microphone = result.state as TalkModePermissionStatus["microphone"];
    } catch {
      // Permissions API may not support microphone query
    }

    // Check if speech recognition is supported
    const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
      (window as unknown as Record<string, unknown>).SpeechRecognition as SpeechRecognitionCtor | undefined ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition as SpeechRecognitionCtor | undefined;

    const speechRecognition: TalkModePermissionStatus["speechRecognition"] = 
      SpeechRecognitionAPI ? "prompt" : "not_supported";

    return { microphone, speechRecognition };
  }

  async requestPermissions(): Promise<TalkModePermissionStatus> {
    // Request microphone permission by attempting to get user media
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch {
      // Permission denied or error
    }

    return this.checkPermissions();
  }

  private setState(state: TalkModeState, statusText: string): void {
    const previousState = this.state;
    this.state = state;
    this.statusText = statusText;
    this.notifyListeners("stateChange", {
      state,
      previousState,
      statusText,
      usingSystemTts: true,
    });
  }
}
