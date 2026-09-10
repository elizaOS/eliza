/**
 * Implements TalkMode in browsers through the Web Speech and speech-synthesis
 * APIs while preserving the native plugin's session-state contract.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  SpeechRecognitionCtor,
  SpeechRecognitionInstance,
  SpeechRecognitionResultEvent,
  SpeechRecognitionWindow,
} from "@elizaos/native-plugin-shared-types";
import type {
  AudioFrameOptions,
  AudioFrameResult,
  SpeakOptions,
  SpeakResult,
  TalkModeConfig,
  TalkModePermissionStatus,
  TalkModeState,
} from "./definitions";

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
  private pendingSpeech = new Map<
    SpeechSynthesisUtterance,
    { cancelled: boolean }
  >();
  private recognition: SpeechRecognitionInstance | null = null;
  private enabled = false;

  constructor() {
    super();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.synthesis = window.speechSynthesis;
    }
  }

  async start(options?: {
    config?: TalkModeConfig;
  }): Promise<{ started: boolean; error?: string }> {
    if (options?.config) {
      this.config = { ...this.config, ...options.config };
    }

    // Check for Web Speech API support
    const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
      ((window as SpeechRecognitionWindow).SpeechRecognition as
        | SpeechRecognitionCtor
        | undefined) ||
      ((window as SpeechRecognitionWindow).webkitSpeechRecognition as
        | SpeechRecognitionCtor
        | undefined);

    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error: "Speech recognition not supported on this browser",
      };
    }

    if (!this.synthesis) {
      console.warn("[TalkMode] Speech synthesis not available on web");
    }

    try {
      // Build and start the recognizer transactionally. Browser implementations
      // may throw from construction, property setup, or start(); none of those
      // paths may publish an enabled/listening session.
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: SpeechRecognitionResultEvent) => {
        const result = event.results[event.results.length - 1];
        const first = result?.[0];
        if (!first || typeof first.transcript !== "string") return;
        const transcript = first.transcript;
        const isFinal = result.isFinal;
        if (!transcript.trim()) return;

        this.notifyListeners("transcript", { transcript, isFinal });

        if (isFinal && transcript.trim()) {
          // Note: Full talk mode flow would need Gateway plugin integration
          // For web, we just emit the transcript
        }
      };

      recognition.onerror = (event: { error: string; message?: string }) => {
        this.notifyListeners("error", {
          code: event.error,
          message: event.message || event.error,
          recoverable: event.error !== "not-allowed",
        });
      };

      recognition.onend = () => {
        // Chrome ends a continuous session spontaneously, including mid-
        // utterance while state is "speaking". Recognition is never paused
        // during speak (it keeps capturing), so restart whenever the session
        // is still enabled; gating on state === "listening" would swallow a
        // mid-TTS onend and leave the recognizer permanently dead (#22369).
        if (this.enabled) {
          // Restart recognition if still enabled
          try {
            this.recognition?.start();
          } catch (err) {
            // error-policy:J6 best-effort restart of a stopped recognizer; genuine failures are warned
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("already started")) {
              console.warn("[TalkMode] Failed to restart recognition:", msg);
            }
          }
        }
      };

      this.recognition = recognition;
      recognition.start();
      this.enabled = true;
      this.setState("listening", "Listening");
      return { started: true };
    } catch (error) {
      // error-policy:J1 boundary translates recognizer initialization failure into a structured { started:false } result
      this.enabled = false;
      this.recognition = null;
      this.setState("idle", "Off");
      const message =
        error instanceof Error ? error.message : "Failed to start";
      return { started: false, error: message };
    }
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.recognition?.stop();
    this.recognition = null;
    this.cancelPendingSpeech();
    this.setState("idle", "Off");
  }

  async isEnabled(): Promise<{ enabled: boolean }> {
    return { enabled: this.enabled };
  }

  async getState(): Promise<{ state: TalkModeState; statusText: string }> {
    return { state: this.state, statusText: this.statusText };
  }

  async updateConfig(options: {
    config: Partial<TalkModeConfig>;
  }): Promise<void> {
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
      const outcome = { cancelled: false };
      this.pendingSpeech.set(utterance, outcome);

      // Always set language — fallback to en-US if directive doesn't specify.
      // Without this, the browser uses the system locale, which may read
      // numbers in the wrong language (e.g., Chinese on a Chinese-locale system).
      utterance.lang = options.directive?.language || "en-US";

      // Apply directive settings if available
      if (
        typeof options.directive?.speed === "number" &&
        Number.isFinite(options.directive.speed) &&
        options.directive.speed > 0
      ) {
        utterance.rate = options.directive.speed;
      }

      // Replaced replies may finish normally; explicitly cancelled replies may
      // not claim successful speech even if the browser later reports an end.
      const isStale = () => this.currentUtterance !== utterance;

      utterance.onend = () => {
        const stale = isStale();
        this.pendingSpeech.delete(utterance);
        if (!stale) this.currentUtterance = null;
        this.notifyListeners("speakComplete", {
          completed: !outcome.cancelled,
        });
        if (!stale) this.setState("listening", "Listening");
        resolve({
          completed: !outcome.cancelled,
          interrupted: outcome.cancelled,
          usedSystemTts: true,
        });
      };

      utterance.onerror = (event) => {
        const stale = isStale();
        this.pendingSpeech.delete(utterance);
        if (!stale) this.currentUtterance = null;
        this.notifyListeners("speakComplete", { completed: false });
        if (!stale) this.setState("idle", "Speech error");
        resolve({
          completed: false,
          interrupted: outcome.cancelled || event.error === "interrupted",
          usedSystemTts: true,
          error: event.error,
        });
      };

      this.synthesis?.speak(utterance);
    });
  }

  async stopSpeaking(): Promise<{ interruptedAt?: number }> {
    if (this.synthesis && this.currentUtterance) {
      this.cancelPendingSpeech();
      // The cancelled utterance's own end event is stale from here on, so the
      // resumed listening state is set here rather than by that handler.
      if (this.enabled) {
        this.setState("listening", "Listening");
      }
      return { interruptedAt: undefined };
    }
    return {};
  }

  private cancelPendingSpeech(): void {
    // cancel() affects the whole browser queue and may synchronously call back.
    for (const outcome of this.pendingSpeech.values()) outcome.cancelled = true;
    this.pendingSpeech.clear();
    this.currentUtterance = null;
    this.synthesis?.cancel();
  }

  async isSpeaking(): Promise<{ speaking: boolean }> {
    return { speaking: this.synthesis?.speaking ?? false };
  }

  async startAudioFrames(
    _options?: AudioFrameOptions,
  ): Promise<AudioFrameResult> {
    // Raw PCM frame capture is a native-only diarization path; on web the Web
    // Speech API gives transcripts only, with no raw-PCM hook.
    return {
      started: false,
      error: "audioFrame capture is not supported on web",
    };
  }

  async stopAudioFrames(): Promise<void> {
    // no-op on web
  }

  async isCapturingAudioFrames(): Promise<{ capturing: boolean }> {
    return { capturing: false };
  }

  async checkPermissions(): Promise<TalkModePermissionStatus> {
    // Check microphone permission
    let microphone: TalkModePermissionStatus["microphone"] = "prompt";
    try {
      const result = await navigator.permissions?.query?.({
        name: "microphone" as PermissionName,
      });
      if (
        result?.state === "granted" ||
        result?.state === "denied" ||
        result?.state === "prompt"
      ) {
        microphone = result.state;
      }
    } catch {
      // error-policy:J4 Permissions API cannot query microphone here; keep the "prompt" default
      // Permissions API may not support microphone query
    }

    // Check if speech recognition is supported
    const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
      ((window as SpeechRecognitionWindow).SpeechRecognition as
        | SpeechRecognitionCtor
        | undefined) ||
      ((window as SpeechRecognitionWindow).webkitSpeechRecognition as
        | SpeechRecognitionCtor
        | undefined);

    const speechRecognition: TalkModePermissionStatus["speechRecognition"] =
      SpeechRecognitionAPI ? "prompt" : "not_supported";

    return { microphone, speechRecognition };
  }

  async requestPermissions(): Promise<TalkModePermissionStatus> {
    // Request microphone permission by attempting to get user media
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        audio: true,
      });
      if (!stream) throw new Error("mediaDevices.getUserMedia unavailable");
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    } catch {
      // error-policy:J4 mic prompt denied/unavailable; the real state is re-read by checkPermissions below
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
