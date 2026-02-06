import type { PluginListenerHandle } from "@capacitor/core";
import type {
  SwabblePlugin,
  SwabbleStartOptions,
  SwabbleStartResult,
  SwabbleConfig,
  SwabblePermissionStatus,
  SwabbleWakeWordEvent,
  SwabbleTranscriptEvent,
  SwabbleStateEvent,
  SwabbleAudioLevelEvent,
  SwabbleErrorEvent,
  SwabbleSpeechSegment,
} from "../../src/definitions";

type EventCallback<T> = (event: T) => void;
type SwabbleEvent =
  | SwabbleWakeWordEvent
  | SwabbleTranscriptEvent
  | SwabbleStateEvent
  | SwabbleAudioLevelEvent
  | SwabbleErrorEvent;

interface ListenerEntry {
  eventName: string;
  callback: EventCallback<SwabbleEvent>;
}

type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = { [key: string]: IpcValue };
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;
type IpcListener = (...args: IpcValue[]) => void;

interface ElectronAPI {
  ipcRenderer: {
    invoke(channel: string, ...args: IpcValue[]): Promise<IpcValue>;
    send(channel: string, ...args: IpcValue[]): void;
    on(channel: string, listener: IpcListener): void;
    removeListener(channel: string, listener: IpcListener): void;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
/**
 * WakeWordGate detects trigger phrases in transcripts.
 *
 * NOTE: When using the Web Speech API fallback (no Whisper IPC),
 * word-level timing is unavailable. In that mode, `postGap` is -1
 * and minPostTriggerGap is not enforced.
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
    if (config.triggers) {
      this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
    }
    if (config.minCommandLength !== undefined) {
      this.minCommandLength = config.minCommandLength;
    }
  }

  /**
   * Match wake word in transcript using text-only detection.
   * Returns postGap=-1 to indicate timing data is unavailable on Electron/web.
   */
  match(transcript: string): { wakeWord: string; command: string; postGap: number } | null {
    const normalizedTranscript = transcript.toLowerCase();

    for (const trigger of this.triggers) {
      const triggerIndex = normalizedTranscript.indexOf(trigger);
      if (triggerIndex === -1) continue;

      // Extract command after the trigger phrase
      const commandStart = triggerIndex + trigger.length;
      const command = transcript.slice(commandStart).trim();

      if (command.length < this.minCommandLength) continue;

      // postGap=-1 indicates timing unavailable on Electron/web platform
      return { wakeWord: trigger, command, postGap: -1 };
    }

    return null;
  }
}

/**
 * Swabble Plugin for Electron
 *
 * Uses Whisper.cpp via Electron IPC when available for full timing parity,
 * with Web Speech API fallback when Whisper bindings are unavailable.
 */
export class SwabbleElectron implements SwabblePlugin {
  private recognition: SpeechRecognition | null = null;
  private config: SwabbleConfig | null = null;
  private wakeGate: WakeWordGate | null = null;
  private isActive = false;
  private segments: SwabbleSpeechSegment[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private listeners: ListenerEntry[] = [];
  private selectedDeviceId: string | null = null;
  private captureStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private captureGain: GainNode | null = null;
  private captureSampleRate = 16000;
  private ipcHandlers: Array<{ channel: string; handler: (data: IpcValue) => void }> = [];

  async start(options: SwabbleStartOptions): Promise<SwabbleStartResult> {
    if (this.isActive) {
      return { started: true };
    }

    this.config = options.config;
    this.wakeGate = new WakeWordGate(options.config);
    this.segments = [];
    this.captureSampleRate = options.config.sampleRate ?? 16000;

    // Try native Whisper via Electron IPC first
    if (window.electron?.ipcRenderer) {
      try {
        const result = await window.electron.ipcRenderer.invoke("swabble:start", options as IpcValue) as SwabbleStartResult;
        if (result.started) {
          this.isActive = true;
          this.setupIpcListeners();
          await this.startAudioCapture();
          return result;
        }
      } catch {
        // Fall through to web implementation
      }
    }

    const SpeechRecognitionAPI =
      (window as Window & { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error: "Speech recognition not supported. Whisper.cpp is unavailable.",
      };
    }

    this.recognition = new SpeechRecognitionAPI();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = options.config.locale || "en-US";

    this.recognition.onstart = () => {
      this.isActive = true;
      this.notifyListeners("stateChange", { state: "listening" });
    };

    this.recognition.onend = () => {
      if (this.isActive) {
        // Restart for continuous listening
        setTimeout(() => {
          if (this.isActive && this.recognition) {
            this.recognition.start();
          }
        }, 100);
      } else {
        this.notifyListeners("stateChange", { state: "idle" });
      }
    };

    this.recognition.onerror = (event) => {
      const recoverable = event.error === "no-speech" || event.error === "aborted";

      this.notifyListeners("error", {
        code: event.error,
        message: `Speech recognition error: ${event.error}`,
        recoverable,
      });

      if (!recoverable) {
        this.isActive = false;
        this.notifyListeners("stateChange", { state: "error", reason: event.error });
      }
    };

    this.recognition.onresult = (event) => {
      this.handleSpeechResult(event);
    };

    await this.startAudioLevelMonitoring();
    this.recognition.start();

    return { started: true };
  }

  private handleSpeechResult(event: SpeechRecognitionEvent): void {
    let transcript = "";
    let isFinal = false;

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      transcript += result[0].transcript;
      if (result.isFinal) {
        isFinal = true;
      }
    }

    // Create segments from words - timing is unavailable on web/Electron platform
    // start=-1 and duration=-1 indicate timing data is not available
    const words = transcript.split(/\s+/).filter((w) => w.length > 0);
    this.segments = words.map((text) => ({
      text,
      start: -1,    // Unavailable on Electron/web
      duration: -1, // Unavailable on Electron/web
      isFinal,
    }));

    this.notifyListeners("transcript", {
      transcript,
      segments: this.segments,
      isFinal,
      confidence: event.results[event.results.length - 1]?.[0]?.confidence,
    });

    if (isFinal && this.wakeGate) {
      const match = this.wakeGate.match(transcript);
      if (match) {
        this.notifyListeners("wakeWord", {
          wakeWord: match.wakeWord,
          command: match.command,
          transcript,
          postGap: match.postGap,
          confidence: event.results[event.results.length - 1]?.[0]?.confidence,
        });
      }
    }
  }

  private setupIpcListeners(): void {
    if (!window.electron?.ipcRenderer) return;

    this.removeIpcListeners();

    const handlers: Array<{ channel: string; handler: (data: IpcValue) => void }> = [
      {
        channel: "swabble:transcript",
        handler: (data) => this.notifyListeners("transcript", data as SwabbleTranscriptEvent),
      },
      {
        channel: "swabble:wakeWord",
        handler: (data) => this.notifyListeners("wakeWord", data as SwabbleWakeWordEvent),
      },
      {
        channel: "swabble:stateChange",
        handler: (data) => this.notifyListeners("stateChange", data as SwabbleStateEvent),
      },
      {
        channel: "swabble:audioLevel",
        handler: (data) => this.notifyListeners("audioLevel", data as SwabbleAudioLevelEvent),
      },
      {
        channel: "swabble:error",
        handler: (data) => this.notifyListeners("error", data as SwabbleErrorEvent),
      },
    ];

    for (const entry of handlers) {
      window.electron.ipcRenderer.on(entry.channel, entry.handler);
      this.ipcHandlers.push(entry);
    }
  }

  private removeIpcListeners(): void {
    if (!window.electron?.ipcRenderer) return;

    for (const entry of this.ipcHandlers) {
      window.electron.ipcRenderer.removeListener(entry.channel, entry.handler);
    }
    this.ipcHandlers = [];
  }

  private async startAudioCapture(): Promise<void> {
    if (this.captureContext || !window.electron?.ipcRenderer) return;

    const constraints: MediaStreamConstraints = {
      audio: this.selectedDeviceId ? { deviceId: { exact: this.selectedDeviceId } } : true,
    };

    this.captureStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.captureContext = new AudioContext();

    const source = this.captureContext.createMediaStreamSource(this.captureStream);
    const processor = this.captureContext.createScriptProcessor(4096, 1, 1);
    const gain = this.captureContext.createGain();
    gain.gain.value = 0;

    this.captureProcessor = processor;
    this.captureGain = gain;

    const inputSampleRate = this.captureContext.sampleRate;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = this.downsampleBuffer(input, inputSampleRate, this.captureSampleRate);
      if (downsampled.length > 0) {
        window.electron?.ipcRenderer.send("swabble:audioChunk", downsampled);
      }

      const level = this.computeRms(input);
      const peak = this.computePeak(input);
      this.notifyListeners("audioLevel", { level, peak });
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(this.captureContext.destination);
  }

  private stopAudioCapture(): void {
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
      this.captureStream.getTracks().forEach((track) => track.stop());
      this.captureStream = null;
    }
  }

  private downsampleBuffer(buffer: Float32Array, inputSampleRate: number, targetSampleRate: number): Float32Array {
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
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        acc += buffer[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? acc / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
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

  private async startAudioLevelMonitoring(): Promise<void> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: this.selectedDeviceId ? { deviceId: { exact: this.selectedDeviceId } } : true,
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      this.levelInterval = setInterval(() => {
        if (!this.analyser) return;

        this.analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        let peak = 0;
        for (const value of dataArray) {
          sum += value;
          peak = Math.max(peak, value);
        }

        const average = sum / dataArray.length;
        const level = average / 255;
        const peakLevel = peak / 255;

        this.notifyListeners("audioLevel", { level, peak: peakLevel });
      }, 100);
    } catch (error) {
      console.warn("Failed to start audio level monitoring:", error);
    }
  }

  private stopAudioLevelMonitoring(): void {
    if (this.levelInterval) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.analyser = null;
  }

  async stop(): Promise<void> {
    this.isActive = false;
    this.removeIpcListeners();
    this.stopAudioCapture();
    this.stopAudioLevelMonitoring();

    if (window.electron?.ipcRenderer) {
      try {
        await window.electron.ipcRenderer.invoke("swabble:stop");
      } catch {
        // Ignore
      }
    }

    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }

    this.notifyListeners("stateChange", { state: "idle" });
  }

  async isListening(): Promise<{ listening: boolean }> {
    return { listening: this.isActive };
  }

  async getConfig(): Promise<{ config: SwabbleConfig | null }> {
    return { config: this.config };
  }

  async updateConfig(options: { config: Partial<SwabbleConfig> }): Promise<void> {
    if (this.config) {
      this.config = { ...this.config, ...options.config };
      this.wakeGate?.updateConfig(options.config);
      this.captureSampleRate = this.config.sampleRate ?? this.captureSampleRate;
    }

    if (window.electron?.ipcRenderer) {
      try {
        await window.electron.ipcRenderer.invoke("swabble:updateConfig", { config: options.config });
      } catch {
        // Ignore
      }
    }
  }

  async checkPermissions(): Promise<SwabblePermissionStatus> {
    let micStatus: "granted" | "denied" | "prompt" = "prompt";

    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      micStatus = result.state as "granted" | "denied" | "prompt";
    } catch {
      // Permissions API may not support microphone query
    }

    const SpeechRecognitionAPI =
      (window as Window & { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    let speechRecognition: SwabblePermissionStatus["speechRecognition"] = SpeechRecognitionAPI ? "granted" : "not_supported";

    if (window.electron?.ipcRenderer) {
      try {
        const whisperStatus = await window.electron.ipcRenderer.invoke("swabble:isWhisperAvailable") as {
          available: boolean;
        };
        if (whisperStatus.available) {
          speechRecognition = "granted";
        }
      } catch {
        // Ignore
      }
    }

    return {
      microphone: micStatus,
      speechRecognition,
    };
  }

  async requestPermissions(): Promise<SwabblePermissionStatus> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return this.checkPermissions();
    } catch {
      return {
        microphone: "denied",
        speechRecognition: "not_supported",
      };
    }
  }

  async getAudioDevices(): Promise<{
    devices: Array<{ id: string; name: string; isDefault: boolean }>;
  }> {
    // Ensure we have permission first (required to get device labels)
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === "audioinput");

    return {
      devices: audioInputs.map((d, i) => ({
        id: d.deviceId,
        name: d.label || `Microphone ${i + 1}`,
        isDefault: d.deviceId === "default" || i === 0,
      })),
    };
  }

  async setAudioDevice(_options: { deviceId: string }): Promise<void> {
    this.selectedDeviceId = _options.deviceId;

    if (window.electron?.ipcRenderer && this.captureContext) {
      this.stopAudioCapture();
      await this.startAudioCapture();
      return;
    }

    throw new Error(
      "setAudioDevice is not supported for Web Speech API. " +
        "Use Whisper.cpp mode for device selection."
    );
  }

  private notifyListeners<T extends SwabbleWakeWordEvent | SwabbleTranscriptEvent | SwabbleStateEvent | SwabbleAudioLevelEvent | SwabbleErrorEvent>(
    eventName: string,
    data: T
  ): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<T>)(data);
      }
    }
  }

  async addListener(
    eventName: "wakeWord",
    listenerFunc: (event: SwabbleWakeWordEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "transcript",
    listenerFunc: (event: SwabbleTranscriptEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "stateChange",
    listenerFunc: (event: SwabbleStateEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "audioLevel",
    listenerFunc: (event: SwabbleAudioLevelEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "error",
    listenerFunc: (event: SwabbleErrorEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listenerFunc: EventCallback<SwabbleEvent>
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

// Export the plugin instance for Capacitor registration
export const Swabble = new SwabbleElectron();
