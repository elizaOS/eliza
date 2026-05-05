import { WebPlugin } from "@capacitor/core";

import type {
  SwabbleConfig,
  SwabblePermissionStatus,
  SwabbleSpeechSegment,
  SwabbleStartOptions,
  SwabbleStartResult,
} from "./definitions";

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: SpeechRecognitionInstance) => void) | null;
  onend: ((this: SpeechRecognitionInstance) => void) | null;
  onerror:
    | ((this: SpeechRecognitionInstance, event: { error: string }) => void)
    | null;
  onresult:
    | ((
        this: SpeechRecognitionInstance,
        event: SpeechRecognitionResultEvent,
      ) => void)
    | null;
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
  [index: number]: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  };
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

type ElectrobunRequestHandler = (params?: unknown) => Promise<unknown>;
type ElectrobunMessageListener = (payload: unknown) => void;

interface ElectrobunRendererRpc {
  request: Record<string, ElectrobunRequestHandler>;
  onMessage: (messageName: string, listener: ElectrobunMessageListener) => void;
  offMessage: (
    messageName: string,
    listener: ElectrobunMessageListener,
  ) => void;
}

type DesktopBridgeWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
};

function getDesktopBridgeWindow(): DesktopBridgeWindow | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as DesktopBridgeWindow;
}

function getElectrobunRendererRpc(): ElectrobunRendererRpc | null {
  const w = getDesktopBridgeWindow();
  return w?.__ELIZA_ELECTROBUN_RPC__ ?? null;
}

async function invokeDesktopBridgeRequest<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}): Promise<T | null> {
  const rpc = getElectrobunRendererRpc();
  const request = rpc?.request?.[options.rpcMethod];
  if (request) {
    return (await request(options.params)) as T;
  }

  return null;
}

function subscribeDesktopBridgeEvent(options: {
  rpcMessage: string;
  ipcChannel: string;
  listener: ElectrobunMessageListener;
}): () => void {
  const rpc = getElectrobunRendererRpc();
  if (rpc) {
    rpc.onMessage(options.rpcMessage, options.listener);
    return () => {
      rpc.offMessage(options.rpcMessage, options.listener);
    };
  }

  return () => {};
}

const getSpeechRecognition = (): SpeechRecognitionCtor | null =>
  (window as SpeechRecognitionWindow).SpeechRecognition ||
  (window as SpeechRecognitionWindow).webkitSpeechRecognition ||
  null;

/**
 * WakeWordGate detects trigger phrases in transcripts.
 *
 * LIMITATION: Web Speech API does not provide word-level timing data.
 * Unlike native implementations, we cannot measure post-trigger gaps.
 * The `postGap` returned is always -1 (unavailable), and minPostTriggerGap is ignored.
 * Detection is purely text-based: trigger phrase + subsequent command text.
 */
class WakeWordGate {
  private triggers: string[];
  private minCommandLength: number;

  constructor(config: SwabbleConfig) {
    this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
    this.minCommandLength = config.minCommandLength ?? 1;
    // Note: minPostTriggerGap cannot be enforced - Web Speech API lacks timing data
  }

  updateConfig(config: Partial<SwabbleConfig>): void {
    if (config.triggers)
      this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
    if (config.minCommandLength !== undefined)
      this.minCommandLength = config.minCommandLength;
  }

  /**
   * Match wake word in transcript using text-only detection.
   * Returns postGap=-1 to indicate timing data is unavailable on web.
   */
  match(
    transcript: string,
  ): { wakeWord: string; command: string; postGap: number } | null {
    const normalizedTranscript = transcript.toLowerCase();

    for (const trigger of this.triggers) {
      const triggerIndex = normalizedTranscript.indexOf(trigger);
      if (triggerIndex === -1) continue;

      // Extract command after the trigger phrase
      const commandStart = triggerIndex + trigger.length;
      const command = transcript.slice(commandStart).trim();

      if (command.length < this.minCommandLength) continue;

      // postGap=-1 indicates timing unavailable on web platform
      return { wakeWord: trigger, command, postGap: -1 };
    }
    return null;
  }
}

export class SwabbleWeb extends WebPlugin {
  private recognition: SpeechRecognitionInstance | null = null;
  private config: SwabbleConfig | null = null;
  private wakeGate: WakeWordGate | null = null;
  private isActive = false;
  private segments: SwabbleSpeechSegment[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  // Native IPC state (Electrobun)
  private captureStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private bridgeSubscriptions: Array<() => void> = [];
  private usingNativeIpc = false;

  private getRendererRpc() {
    return getElectrobunRendererRpc() ?? null;
  }

  private subscribeDesktopEvent(options: {
    rpcMessage: string;
    ipcChannel: string;
    listener: (payload: unknown) => void;
  }): void {
    this.bridgeSubscriptions.push(subscribeDesktopBridgeEvent(options));
  }

  private async invokeDesktopRequest<T>(options: {
    rpcMethod: string;
    ipcChannel: string;
    params?: unknown;
  }): Promise<T | null> {
    return await invokeDesktopBridgeRequest<T>(options);
  }

  private setupNativeListeners(): void {
    this.removeNativeListeners();
    this.subscribeDesktopEvent({
      rpcMessage: "swabbleWakeWord",
      ipcChannel: "swabble:wakeWord",
      listener: (payload) => {
        this.notifyListeners("wakeWord", payload as Record<string, unknown>);
      },
    });
    this.subscribeDesktopEvent({
      rpcMessage: "swabbleStateChanged",
      ipcChannel: "swabble:stateChange",
      listener: (payload) => {
        const listening =
          typeof (payload as { listening?: unknown }).listening === "boolean"
            ? (payload as { listening: boolean }).listening
            : false;
        this.isActive = listening;
        this.notifyListeners("stateChange", {
          state: listening ? "listening" : "idle",
        });
      },
    });
    this.subscribeDesktopEvent({
      rpcMessage: "swabbleTranscript",
      ipcChannel: "swabble:transcript",
      listener: (payload) => {
        this.notifyListeners("transcript", payload as Record<string, unknown>);
      },
    });
    this.subscribeDesktopEvent({
      rpcMessage: "swabbleError",
      ipcChannel: "swabble:error",
      listener: (payload) => {
        this.notifyListeners("error", payload as Record<string, unknown>);
      },
    });
  }

  private removeNativeListeners(): void {
    for (const unsubscribe of this.bridgeSubscriptions) {
      unsubscribe();
    }
    this.bridgeSubscriptions = [];
  }

  private async startNativeAudioCapture(sampleRate = 16000): Promise<void> {
    const rpcRequest = this.getRendererRpc()?.request?.swabbleAudioChunk;
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch(() => null);
    if (!stream) return;
    this.captureStream = stream;
    this.captureContext = new AudioContext();
    const source = this.captureContext.createMediaStreamSource(stream);
    const processor = this.captureContext.createScriptProcessor(4096, 1, 1);
    this.captureProcessor = processor;
    const inputRate = this.captureContext.sampleRate;
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      this.notifyListeners("audioLevel", {
        level: this.computeRms(input),
        peak: this.computePeak(input),
      });
      const ratio = inputRate / sampleRate;
      const out = new Float32Array(Math.round(input.length / ratio));
      for (let i = 0; i < out.length; i++) {
        let acc = 0;
        let cnt = 0;
        const start = Math.round(i * ratio);
        const end = Math.round((i + 1) * ratio);
        for (let j = start; j < end && j < input.length; j++) {
          acc += input[j];
          cnt++;
        }
        out[i] = cnt > 0 ? acc / cnt : 0;
      }
      const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      if (rpcRequest) {
        void rpcRequest({ data: btoa(binary) }).catch(() => {});
      }
    };
    source.connect(processor);
    const sink = this.captureContext.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(this.captureContext.destination);
  }

  private computeRms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  private computePeak(samples: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    return peak;
  }

  private stopNativeAudioCapture(): void {
    this.captureProcessor?.disconnect();
    this.captureProcessor = null;
    this.captureContext?.close();
    this.captureContext = null;
    this.captureStream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.captureStream = null;
  }

  async start(options: SwabbleStartOptions): Promise<SwabbleStartResult> {
    if (this.isActive) return { started: true };

    // Delegate to the native desktop bridge when available.
    const rpc = this.getRendererRpc();
    if (rpc) {
      try {
        const result = await this.invokeDesktopRequest<SwabbleStartResult>({
          rpcMethod: "swabbleStart",
          ipcChannel: "swabble:start",
          params: options,
        });
        if (result?.started) {
          this.isActive = true;
          this.usingNativeIpc = true;
          this.config = options.config;
          this.setupNativeListeners();
          await this.startNativeAudioCapture(
            options.config.sampleRate ?? 16000,
          );
          return result;
        }
      } catch {
        // Fall through to Web Speech API
      }
    }

    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error: "Speech recognition not supported in this browser",
      };
    }

    this.config = options.config;
    this.wakeGate = new WakeWordGate(options.config);
    this.segments = [];

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = options.config.locale || "en-US";

    recognition.onstart = () => {
      this.isActive = true;
      this.notifyListeners("stateChange", { state: "listening" });
    };

    recognition.onend = () => {
      if (this.isActive) {
        this.recognition?.start();
      } else {
        this.notifyListeners("stateChange", { state: "idle" });
      }
    };

    recognition.onerror = (event: { error: string }) => {
      const recoverable =
        event.error === "no-speech" || event.error === "aborted";
      this.notifyListeners("error", {
        code: event.error,
        message: `Speech recognition error: ${event.error}`,
        recoverable,
      });
      if (!recoverable) {
        this.isActive = false;
        this.notifyListeners("stateChange", {
          state: "error",
          reason: event.error,
        });
      }
    };

    recognition.onresult = (event: SpeechRecognitionResultEvent) =>
      this.handleSpeechResult(event);

    this.recognition = recognition;
    await this.startAudioLevelMonitoring();
    recognition.start();
    return { started: true };
  }

  private handleSpeechResult(event: SpeechRecognitionResultEvent): void {
    let transcript = "";
    let isFinal = false;

    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) isFinal = true;
    }

    // Web Speech API does not provide word-level timing.
    // Segments are provided for API compatibility but timing values are approximations.
    const words = transcript.split(/\s+/).filter(Boolean);
    this.segments = words.map((text) => ({
      text,
      start: -1, // Unavailable on web
      duration: -1, // Unavailable on web
      isFinal,
    }));

    const lastResult = event.results[event.results.length - 1];
    const confidence = lastResult?.[0]?.confidence;

    this.notifyListeners("transcript", {
      transcript,
      segments: this.segments,
      isFinal,
      confidence,
    });

    if (isFinal && this.wakeGate) {
      const match = this.wakeGate.match(transcript);
      if (match) {
        this.notifyListeners("wakeWord", { ...match, transcript, confidence });
      }
    }
  }

  private async startAudioLevelMonitoring(): Promise<void> {
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch(() => null);
    if (!stream) return;

    this.mediaStream = stream;
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;

    this.audioContext.createMediaStreamSource(stream).connect(this.analyser);
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.levelInterval = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      const sum = dataArray.reduce((a, b) => a + b, 0);
      this.notifyListeners("audioLevel", {
        level: sum / dataArray.length / 255,
        peak: Math.max(...dataArray) / 255,
      });
    }, 100);
  }

  private stopAudioLevelMonitoring(): void {
    if (this.levelInterval) clearInterval(this.levelInterval);
    this.levelInterval = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.mediaStream = null;
    this.analyser = null;
  }

  async stop(): Promise<void> {
    this.isActive = false;

    // Clean up native IPC if in native mode
    if (this.usingNativeIpc) {
      this.usingNativeIpc = false;
      this.removeNativeListeners();
      this.stopNativeAudioCapture();
      void this.invokeDesktopRequest({
        rpcMethod: "swabbleStop",
        ipcChannel: "swabble:stop",
      });
      this.notifyListeners("stateChange", { state: "idle" });
      return;
    }

    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    this.stopAudioLevelMonitoring();
    this.notifyListeners("stateChange", { state: "idle" });
  }

  async isListening(): Promise<{ listening: boolean }> {
    return { listening: this.isActive };
  }

  async getConfig(): Promise<{ config: SwabbleConfig | null }> {
    return { config: this.config };
  }

  async updateConfig(options: {
    config: Partial<SwabbleConfig>;
  }): Promise<void> {
    if (this.config) {
      this.config = { ...this.config, ...options.config };
      this.wakeGate?.updateConfig(options.config);

      if (options.config.locale && this.recognition) {
        this.recognition.lang = options.config.locale;
      }
    }

    // Sync to native IPC if active
    if (this.usingNativeIpc) {
      void this.invokeDesktopRequest({
        rpcMethod: "swabbleUpdateConfig",
        ipcChannel: "swabble:updateConfig",
        params: options.config,
      });
    }
  }

  async checkPermissions(): Promise<SwabblePermissionStatus> {
    let microphone: SwabblePermissionStatus["microphone"] = "prompt";
    try {
      const result = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      microphone = result.state as SwabblePermissionStatus["microphone"];
    } catch {
      /* permissions.query not supported for microphone in some browsers */
    }
    let speechRecognition: SwabblePermissionStatus["speechRecognition"] =
      getSpeechRecognition() ? "granted" : "not_supported";
    const whisperStatus = await this.invokeDesktopRequest<{
      available: boolean;
    }>({
      rpcMethod: "swabbleIsWhisperAvailable",
      ipcChannel: "swabble:isWhisperAvailable",
    });
    if (whisperStatus?.available) {
      speechRecognition = "granted";
    }

    return {
      microphone,
      speechRecognition,
    };
  }

  async requestPermissions(): Promise<SwabblePermissionStatus> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return this.checkPermissions();
    } catch {
      return {
        microphone: "denied",
        speechRecognition: "denied",
      };
    }
  }

  async getAudioDevices(): Promise<{
    devices: Array<{ id: string; name: string; isDefault: boolean }>;
  }> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          id: d.deviceId,
          name: d.label || `Microphone ${i + 1}`,
          isDefault: d.deviceId === "default",
        }));
      return { devices: audioInputs };
    } catch {
      return { devices: [] };
    }
  }

  async setAudioDevice(_options: { deviceId: string }): Promise<void> {
    // Web Speech API doesn't support device selection directly.
    // The browser uses its default audio input device.
    throw new Error(
      "setAudioDevice is not supported on web platform - browser uses system default audio input",
    );
  }
}
