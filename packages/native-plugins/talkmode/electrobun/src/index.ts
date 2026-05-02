/// <reference path="./global.d.ts" />
/**
 * TalkMode Plugin for Electrobun
 *
 * Provides full conversation mode with STT → chat → TTS on desktop platforms.
 *
 * STT Options:
 * - Web Speech API (online, Chrome-based)
 * - Whisper.cpp via Node.js bindings (offline, requires setup)
 *
 * TTS Options:
 * - ElevenLabs API streaming (online, high quality)
 * - System TTS via speechSynthesis API
 * - Native TTS via the Electrobun bridge (platform-specific)
 */

import type { PluginListenerHandle } from "@capacitor/core";
import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/app-core";
import type { EventCallback, ListenerEntry as BaseListenerEntry } from "../../../shared-types.js";
import type {
  SpeakOptions,
  SpeakResult,
  TalkModeConfig,
  TalkModeErrorEvent,
  TalkModePermissionStatus,
  TalkModePlugin,
  TalkModeState,
  TalkModeStateEvent,
  TalkModeTranscriptEvent,
  TTSCompleteEvent,
  TTSSpeakingEvent,
} from "../../src/definitions";

type TalkModeEvent =
  | TalkModeStateEvent
  | TalkModeTranscriptEvent
  | TTSSpeakingEvent
  | TTSCompleteEvent
  | TalkModeErrorEvent;

type ListenerEntry = BaseListenerEntry<string, TalkModeEvent>;

interface NativeTalkModeConfig {
  engine?: "whisper" | "web";
  modelSize?: string;
  language?: string;
  voiceId?: string;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTalkModeState = (value: unknown): value is TalkModeState =>
  value === "idle" ||
  value === "listening" ||
  value === "processing" ||
  value === "speaking" ||
  value === "error";

const getStatusTextForState = (
  state: TalkModeState,
  usingSystemTts = false,
): string => {
  switch (state) {
    case "idle":
      return "Off";
    case "listening":
      return "Listening";
    case "processing":
      return "Processing";
    case "speaking":
      return usingSystemTts ? "Speaking (System)" : "Speaking";
    case "error":
      return "Speech error";
  }
};

const toNativeTalkModeConfig = (
  config?: Partial<TalkModeConfig>,
): NativeTalkModeConfig | null => {
  if (!config) {
    return null;
  }

  const nativeConfig: NativeTalkModeConfig = {};

  if (config.stt?.engine) {
    nativeConfig.engine = config.stt.engine;
  }
  if (config.stt?.modelSize) {
    nativeConfig.modelSize = config.stt.modelSize;
  }
  if (config.stt?.language) {
    nativeConfig.language = config.stt.language;
  }
  if (config.tts?.voiceId) {
    nativeConfig.voiceId = config.tts.voiceId;
  }

  return Object.keys(nativeConfig).length > 0 ? nativeConfig : null;
};

/**
 * TalkMode Plugin implementation for Electrobun
 */
export class TalkModeElectrobun implements TalkModePlugin {
  private config: TalkModeConfig = {};
  private captureChunkCount = 0;
  private state: TalkModeState = "idle";
  private statusText = "Off";
  private enabled = false;
  private isSpeakingValue = false;
  private usedSystemTts = false;
  private listeners: ListenerEntry[] = [];

  // Speech recognition
  private recognition: SpeechRecognition | null = null;

  // TTS
  private synthesis: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private audioContext: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;

  // Audio capture for Whisper (renderer -> main)
  private captureContext: AudioContext | null = null;
  private captureStream: MediaStream | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private captureGain: GainNode | null = null;
  private captureSampleRate = 16000;

  private bridgeSubscriptions: Array<() => void> = [];

  constructor() {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.synthesis = window.speechSynthesis;
    }
  }

  private logDebug(message: string, details?: unknown): void {
    if (typeof details === "undefined") {
      console.info(`[TalkModeElectrobun] ${message}`);
      return;
    }
    console.info(`[TalkModeElectrobun] ${message}`, details);
  }

  private async invokeBridge<T>(
    rpcMethod: string,
    ipcChannel: string,
    params?: unknown,
  ): Promise<T | null> {
    try {
      return await invokeDesktopBridgeRequest<T>({
        rpcMethod,
        ipcChannel,
        params,
      });
    } catch {
      return null;
    }
  }

  private async getDesktopPlatform(): Promise<string | null> {
    return this.invokeBridge<string>(
      "permissionsGetPlatform",
      "permissions:getPlatform",
    );
  }

  // MARK: - Plugin Methods

  async start(options?: {
    config?: TalkModeConfig;
  }): Promise<{ started: boolean; error?: string }> {
    if (options?.config) {
      this.config = { ...this.config, ...options.config };
    }

    const nativeConfig = toNativeTalkModeConfig(options?.config);
    if (nativeConfig) {
      await this.invokeBridge(
        "talkmodeUpdateConfig",
        "talkmode:updateConfig",
        nativeConfig,
      );
    }

    // Try native STT/TTS via the Electrobun bridge first
    this.logDebug("start requested", {
      hasDirectRpc: !!getElectrobunRendererRpc(),
      requestedEngine: options?.config?.stt?.engine ?? null,
      requestedLanguage: options?.config?.stt?.language ?? null,
    });

    const nativeResult = await this.invokeBridge<{
      available?: boolean;
      started?: boolean;
      reason?: string;
      error?: string;
    }>("talkmodeStart", "talkmode:start");
    if (nativeResult) {
      const started = nativeResult.available ?? nativeResult.started ?? false;
      if (started) {
        const whisperStatus = await this.invokeBridge<{ available: boolean }>(
          "talkmodeIsWhisperAvailable",
          "talkmode:isWhisperAvailable",
        );
        if (whisperStatus?.available) {
          this.enabled = true;
          this.setupNativeListeners();
          this.setState("listening", "Listening");
          this.captureSampleRate = this.config.stt?.sampleRate ?? 16000;
          try {
            await this.startAudioCapture();
            this.logDebug("native whisper capture started", {
              sampleRate: this.captureSampleRate,
            });
            return { started: true };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to start desktop microphone capture";
            this.logDebug("native whisper capture failed", {
              message,
            });
            this.enabled = false;
            this.stopAudioCapture();
            await this.invokeBridge("talkmodeStop", "talkmode:stop");
            return { started: false, error: message };
          }
        }

        await this.invokeBridge("talkmodeStop", "talkmode:stop");
      }

      if (nativeResult.error || nativeResult.reason) {
        return {
          started: false,
          error: nativeResult.error ?? nativeResult.reason,
        };
      }
    }

    // Fallback to Web Speech API
    const SpeechRecognitionAPI =
      (
        window as Window & {
          SpeechRecognition?: typeof SpeechRecognition;
          webkitSpeechRecognition?: typeof SpeechRecognition;
        }
      ).SpeechRecognition ||
      (
        window as Window & {
          webkitSpeechRecognition?: typeof SpeechRecognition;
        }
      ).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error:
          "Speech recognition not supported. Consider installing Whisper.cpp for offline support.",
      };
    }

    this.enabled = true;
    this.recognition = new SpeechRecognitionAPI();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0].transcript;
      const isFinal = result.isFinal;

      this.notifyListeners("transcript", { transcript, isFinal });
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.notifyListeners("error", {
        code: event.error,
        message: event.message || event.error,
        recoverable: event.error !== "not-allowed",
      });
    };

    this.recognition.onend = () => {
      if (this.enabled && this.state === "listening") {
        try {
          this.recognition?.start();
        } catch {
          // Ignore - may already be starting
        }
      }
    };

    try {
      this.recognition.start();
      this.setState("listening", "Listening");
      return { started: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start";
      return { started: false, error: message };
    }
  }

  private setupNativeListeners(): void {
    this.removeNativeListeners();

    const bridgeHandlers = [
      {
        rpcMessage: "talkmodeStateChanged",
        ipcChannel: "talkmode:stateChanged",
        listener: (data: unknown) => {
          this.handleNativeStateChanged(data);
        },
      },
      {
        rpcMessage: "talkmodeTranscript",
        ipcChannel: "talkmode:transcript",
        listener: (data: unknown) => {
          this.notifyListeners(
            "transcript",
            this.normalizeTranscriptEvent(data),
          );
        },
      },
      {
        rpcMessage: "talkmodeError",
        ipcChannel: "talkmode:error",
        listener: (data: unknown) => {
          this.notifyListeners("error", data as TalkModeErrorEvent);
        },
      },
    ];

    for (const entry of bridgeHandlers) {
      const unsubscribe = subscribeDesktopBridgeEvent({
        rpcMessage: entry.rpcMessage,
        ipcChannel: entry.ipcChannel,
        listener: entry.listener,
      });
      this.bridgeSubscriptions.push(unsubscribe);
    }
  }

  private removeNativeListeners(): void {
    for (const unsubscribe of this.bridgeSubscriptions) {
      unsubscribe();
    }
    this.bridgeSubscriptions = [];
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.stopAudioCapture();
    await this.invokeBridge("talkmodeStop", "talkmode:stop");
    this.removeNativeListeners();

    this.recognition?.stop();
    this.recognition = null;
    this.synthesis?.cancel();
    this.currentUtterance = null;
    this.stopAudio();
    this.setState("idle", "Off");
  }

  async isEnabled(): Promise<{ enabled: boolean }> {
    const nativeEnabled = await this.invokeBridge<{ enabled: boolean }>(
      "talkmodeIsEnabled",
      "talkmode:isEnabled",
    );
    if (nativeEnabled) {
      this.enabled = nativeEnabled.enabled;
      return nativeEnabled;
    }
    return { enabled: this.enabled };
  }

  async getState(): Promise<{ state: TalkModeState; statusText: string }> {
    const nativeState = await this.invokeBridge<{ state: TalkModeState }>(
      "talkmodeGetState",
      "talkmode:getState",
    );
    if (nativeState?.state) {
      this.state = nativeState.state;
      this.statusText = getStatusTextForState(
        nativeState.state,
        this.usedSystemTts,
      );
      return { state: this.state, statusText: this.statusText };
    }
    return { state: this.state, statusText: this.statusText };
  }

  async updateConfig(options: {
    config: Partial<TalkModeConfig>;
  }): Promise<void> {
    this.config = { ...this.config, ...options.config };
    const nativeConfig = toNativeTalkModeConfig(options.config);
    if (!nativeConfig) {
      return;
    }

    await this.invokeBridge(
      "talkmodeUpdateConfig",
      "talkmode:updateConfig",
      nativeConfig,
    );
  }

  async speak(options: SpeakOptions): Promise<SpeakResult> {
    const text = options.text.trim();
    if (!text) {
      return { completed: true, interrupted: false, usedSystemTts: false };
    }

    // Try ElevenLabs via fetch (may have CORS issues in the desktop runtime)
    if (
      !options.useSystemTts &&
      this.config.tts?.apiKey &&
      this.config.tts?.voiceId
    ) {
      try {
        return await this.speakWithElevenLabs(text, options);
      } catch (error) {
        console.warn(
          "[TalkMode] ElevenLabs TTS failed, falling back to system:",
          error,
        );
      }
    }

    // Fallback to system TTS
    return this.speakWithSystemTts(text);
  }

  private async speakWithElevenLabs(
    text: string,
    options: SpeakOptions,
  ): Promise<SpeakResult> {
    const voiceId = options.directive?.voiceId || this.config.tts?.voiceId;
    const apiKey = this.config.tts?.apiKey;
    const modelId =
      options.directive?.modelId ||
      this.config.tts?.modelId ||
      "eleven_flash_v2_5";

    if (!voiceId || !apiKey) {
      throw new Error("Missing voiceId or apiKey for ElevenLabs");
    }

    this.isSpeakingValue = true;
    this.usedSystemTts = false;
    this.setState("speaking", "Speaking");
    this.notifyListeners("speaking", { text, isSystemTts: false });

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            output_format: "mp3_22050_32",
            voice_settings: {
              stability: options.directive?.stability ?? 0.5,
              similarity_boost: options.directive?.similarity ?? 0.75,
              speed: options.directive?.speed ?? 1.0,
            },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status}`);
      }

      const audioData = await response.arrayBuffer();
      await this.playAudioBuffer(audioData);

      this.isSpeakingValue = false;
      this.notifyListeners("speakComplete", { completed: true });
      this.setState("listening", "Listening");

      return { completed: true, interrupted: false, usedSystemTts: false };
    } catch (error) {
      this.isSpeakingValue = false;
      throw error;
    }
  }

  private async playAudioBuffer(arrayBuffer: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.audioContext = new AudioContext();

      this.audioContext.decodeAudioData(
        arrayBuffer,
        (buffer) => {
          const source = this.audioContext?.createBufferSource();
          if (source && this.audioContext) {
            this.audioSource = source;
            source.buffer = buffer;
            source.connect(this.audioContext.destination);
            source.onended = () => {
              this.stopAudio();
              resolve();
            };
            source.start(0);
          } else {
            reject(new Error("Audio context invalid"));
          }
        },
        (error) => {
          this.stopAudio();
          reject(error);
        },
      );
    });
  }

  private async startAudioCapture(): Promise<void> {
    if (
      this.captureContext ||
      !getElectrobunRendererRpc()?.request?.talkmodeAudioChunk
    ) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("navigator.mediaDevices.getUserMedia is unavailable");
    }
    if (typeof AudioContext === "undefined") {
      throw new Error("AudioContext is unavailable");
    }

    this.captureChunkCount = 0;
    this.captureStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    this.captureContext = new AudioContext();
    if (typeof this.captureContext.resume === "function") {
      await this.captureContext.resume().catch((error) => {
        this.logDebug("capture AudioContext resume failed", {
          message: error instanceof Error ? error.message : String(error),
          state: this.captureContext?.state,
        });
      });
    }
    this.logDebug("capture stream acquired", {
      contextState: this.captureContext.state,
      sampleRate: this.captureContext.sampleRate,
    });
    const source = this.captureContext.createMediaStreamSource(
      this.captureStream,
    );
    const processor = this.captureContext.createScriptProcessor(4096, 1, 1);
    const gain = this.captureContext.createGain();
    gain.gain.value = 0;

    this.captureProcessor = processor;
    this.captureGain = gain;

    const inputSampleRate = this.captureContext.sampleRate;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = this.downsampleBuffer(
        input,
        inputSampleRate,
        this.captureSampleRate,
      );
      if (downsampled.length > 0) {
        this.sendAudioChunk(downsampled);
      }
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(this.captureContext.destination);
  }

  private sendAudioChunk(downsampled: Float32Array): void {
    const rpcRequest = getElectrobunRendererRpc()?.request?.talkmodeAudioChunk;
    this.captureChunkCount += 1;
    if (this.captureChunkCount === 1) {
      this.logDebug("sending first captured audio chunk", {
        samples: downsampled.length,
        sampleRate: this.captureSampleRate,
      });
    }
    if (!rpcRequest) {
      return;
    }

    const bytes = new Uint8Array(
      downsampled.buffer,
      downsampled.byteOffset,
      downsampled.byteLength,
    );
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    void rpcRequest({ data: btoa(binary) }).catch(() => {});
  }

  private stopAudioCapture(): void {
    this.captureChunkCount = 0;
    if (this.captureProcessor) {
      this.captureProcessor.disconnect();
      this.captureProcessor = null;
    }
    if (this.captureGain) {
      this.captureGain.disconnect();
      this.captureGain = null;
    }
    if (this.captureContext) {
      void this.captureContext.close();
      this.captureContext = null;
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.captureStream = null;
    }
  }

  private downsampleBuffer(
    buffer: Float32Array,
    inputSampleRate: number,
    targetSampleRate: number,
  ): Float32Array {
    if (targetSampleRate >= inputSampleRate) {
      return buffer;
    }

    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let acc = 0;
      let count = 0;
      for (
        let i = offsetBuffer;
        i < nextOffsetBuffer && i < buffer.length;
        i++
      ) {
        acc += buffer[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? acc / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  private stopAudio(): void {
    if (this.audioSource) {
      try {
        this.audioSource.stop();
      } catch {
        // Ignore - may already be stopped
      }
      this.audioSource = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private async speakWithSystemTts(text: string): Promise<SpeakResult> {
    if (!this.synthesis) {
      return {
        completed: false,
        interrupted: false,
        usedSystemTts: true,
        error: "Speech synthesis not available",
      };
    }

    this.isSpeakingValue = true;
    this.usedSystemTts = true;
    this.setState("speaking", "Speaking (System)");
    this.notifyListeners("speaking", { text, isSystemTts: true });

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      this.currentUtterance = utterance;

      utterance.onend = () => {
        this.currentUtterance = null;
        this.isSpeakingValue = false;
        this.notifyListeners("speakComplete", { completed: true });
        this.setState("listening", "Listening");
        resolve({ completed: true, interrupted: false, usedSystemTts: true });
      };

      utterance.onerror = (event) => {
        this.currentUtterance = null;
        this.isSpeakingValue = false;
        this.notifyListeners("speakComplete", { completed: false });
        this.setState("idle", "Speech error");
        resolve({
          completed: false,
          interrupted: event.error === "interrupted",
          usedSystemTts: true,
          error: event.error,
        });
      };

      this.synthesis?.speak(utterance);
    });
  }

  private handleNativeStateChanged(data: unknown): void {
    if (!isObjectRecord(data) || !isTalkModeState(data.state)) {
      return;
    }

    const previousState = this.state;
    this.state = data.state;
    this.statusText = getStatusTextForState(data.state, this.usedSystemTts);
    this.notifyListeners("stateChange", {
      state: data.state,
      previousState,
      statusText: this.statusText,
      usingSystemTts: this.usedSystemTts,
    });
  }

  private normalizeTranscriptEvent(data: unknown): TalkModeTranscriptEvent {
    if (!isObjectRecord(data)) {
      return { transcript: "", isFinal: true };
    }

    return {
      transcript:
        typeof data.transcript === "string"
          ? data.transcript
          : typeof data.text === "string"
            ? data.text
            : "",
      isFinal: typeof data.isFinal === "boolean" ? data.isFinal : true,
    };
  }

  async stopSpeaking(): Promise<{ interruptedAt?: number }> {
    this.stopAudio();

    if (this.synthesis && this.currentUtterance) {
      this.synthesis.cancel();
      this.currentUtterance = null;
    }

    this.isSpeakingValue = false;
    return {};
  }

  async isSpeaking(): Promise<{ speaking: boolean }> {
    const nativeSpeaking = await this.invokeBridge<{ speaking: boolean }>(
      "talkmodeIsSpeaking",
      "talkmode:isSpeaking",
    );
    if (nativeSpeaking) {
      this.isSpeakingValue = nativeSpeaking.speaking;
      return nativeSpeaking;
    }
    return {
      speaking: this.isSpeakingValue || (this.synthesis?.speaking ?? false),
    };
  }

  async checkPermissions(): Promise<TalkModePermissionStatus> {
    let microphone: TalkModePermissionStatus["microphone"] = "prompt";

    try {
      const result = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      microphone = result.state as TalkModePermissionStatus["microphone"];
    } catch {
      // Permissions API may not support microphone query
    }

    const SpeechRecognitionAPI =
      (
        window as Window & {
          SpeechRecognition?: typeof SpeechRecognition;
          webkitSpeechRecognition?: typeof SpeechRecognition;
        }
      ).SpeechRecognition ||
      (
        window as Window & {
          webkitSpeechRecognition?: typeof SpeechRecognition;
        }
      ).webkitSpeechRecognition;

    let speechRecognition: TalkModePermissionStatus["speechRecognition"] =
      SpeechRecognitionAPI ? "prompt" : "not_supported";

    const whisperStatus = await this.invokeBridge<{ available: boolean }>(
      "talkmodeIsWhisperAvailable",
      "talkmode:isWhisperAvailable",
    );
    if (whisperStatus?.available) {
      speechRecognition = "granted";
    }

    return { microphone, speechRecognition };
  }

  async requestPermissions(): Promise<TalkModePermissionStatus> {
    if ((await this.getDesktopPlatform()) === "win32") {
      return this.checkPermissions();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    } catch {
      // Permission denied
    }

    return this.checkPermissions();
  }

  // MARK: - State Management

  private setState(state: TalkModeState, statusText: string): void {
    const previousState = this.state;
    this.state = state;
    this.statusText = statusText;
    this.notifyListeners("stateChange", {
      state,
      previousState,
      statusText,
      usingSystemTts: this.usedSystemTts,
    });
  }

  // MARK: - Event Listeners

  private notifyListeners<T>(eventName: string, data: T): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<T>)(data);
      }
    }
  }

  async addListener(
    eventName: "stateChange",
    listenerFunc: (event: TalkModeStateEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "transcript",
    listenerFunc: (event: TalkModeTranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "speaking",
    listenerFunc: (event: TTSSpeakingEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "speakComplete",
    listenerFunc: (event: TTSCompleteEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "error",
    listenerFunc: (event: TalkModeErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listenerFunc: EventCallback<unknown>,
  ): Promise<PluginListenerHandle> {
    const entry: ListenerEntry = { eventName, callback: listenerFunc };
    this.listeners.push(entry);

    return {
      remove: async () => {
        const idx = this.listeners.indexOf(entry);
        if (idx >= 0) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners = [];
  }
}

// Export the plugin instance
export const TalkMode = new TalkModeElectrobun();
