import {
  encodeMicCommand,
  type G1Event,
  type GlassSide,
  parseG1Notification,
  type SmartglassesAudioEncoding,
} from "../protocol.js";
import type { SmartglassesTransport, SmartglassesWifiResult } from "./types.js";

export class MockSmartglassesTransport implements SmartglassesTransport {
  readonly name = "mock-smartglasses";
  readonly writes: Array<{ side: GlassSide; data: Uint8Array }> = [];
  readonly wifiRequests: Array<{
    op: "scan" | "status" | "configure";
    ssid?: string;
    password?: string;
  }> = [];
  wifiResult: SmartglassesWifiResult = {
    available: true,
    status: "mock-wifi-ready",
    networks: ["MockNet"],
  };
  private connected = false;
  private eventCallbacks = new Set<(event: G1Event) => void>();
  private audioCallbacks = new Set<
    (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void
  >();
  private transcriptCallbacks = new Set<
    (text: string, isFinal: boolean, metadata?: Record<string, unknown>) => void
  >();

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async write(side: GlassSide, data: Uint8Array): Promise<void> {
    this.writes.push({ side, data: new Uint8Array(data) });
  }

  async writeBoth(data: Uint8Array): Promise<void> {
    await this.write("left", data);
    await this.write("right", data);
  }

  async openMicrophone(enabled: boolean): Promise<void> {
    await this.write("right", encodeMicCommand(enabled));
    this.emitRaw("right", encodeMicCommand(enabled));
  }

  onEvent(callback: (event: G1Event) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  onAudio(
    callback: (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void,
  ): () => void {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  onTranscript(
    callback: (
      text: string,
      isFinal: boolean,
      metadata?: Record<string, unknown>,
    ) => void,
  ): () => void {
    this.transcriptCallbacks.add(callback);
    return () => this.transcriptCallbacks.delete(callback);
  }

  emitRaw(side: GlassSide, data: Uint8Array): void {
    const event = parseG1Notification(side, data);
    this.emitEvent(event);
  }

  emitEvent(event: G1Event): void {
    for (const callback of this.eventCallbacks) callback(event);
    const audioData = event.audioPcm ?? event.audioData;
    if (audioData) {
      for (const callback of this.audioCallbacks)
        callback(
          audioData,
          16_000,
          event.side,
          event.audioEncoding,
          event.sequence,
        );
    }
  }

  emitTranscript(
    text: string,
    isFinal = true,
    metadata?: Record<string, unknown>,
  ): void {
    for (const callback of this.transcriptCallbacks)
      callback(text, isFinal, metadata);
  }

  async scanWifi(): Promise<SmartglassesWifiResult> {
    this.wifiRequests.push({ op: "scan" });
    return this.wifiResult;
  }

  async getWifiStatus(): Promise<SmartglassesWifiResult> {
    this.wifiRequests.push({ op: "status" });
    return this.wifiResult;
  }

  async configureWifi(
    ssid: string,
    password: string,
  ): Promise<SmartglassesWifiResult> {
    this.wifiRequests.push({ op: "configure", ssid, password });
    return {
      ...this.wifiResult,
      status: `mock credentials sent for ${ssid}`,
    };
  }

  supportsWifi(): boolean {
    return true;
  }
}
