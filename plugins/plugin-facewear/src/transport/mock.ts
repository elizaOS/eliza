/**
 * Mock smartglasses transport provides deterministic G1 writes, events, audio,
 * transcripts, and Wi-Fi responses for tests and local simulation.
 */
import {
  encodeMicCommand,
  type G1Event,
  type GlassSide,
  parseG1Notification,
  type SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";
import type {
  SmartglassesConnectedLenses,
  SmartglassesTransport,
  SmartglassesWifiResult,
} from "./types.ts";

export class MockSmartglassesTransport implements SmartglassesTransport {
  readonly name = "mock-smartglasses";
  readonly writes: Array<{ side: GlassSide; data: Uint8Array }> = [];
  readonly wifiRequests: Array<{
    op: "scan" | "status" | "configure" | "setup";
    ssid?: string;
    password?: string;
    reason?: string;
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
  private wifiCallbacks = new Set<(status: SmartglassesWifiResult) => void>();

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectedLenses(): SmartglassesConnectedLenses {
    if (!this.connected) return {};
    return {
      left: {
        connected: true,
        name: "Mock Even G1 Left",
        address: "mock-left",
      },
      right: {
        connected: true,
        name: "Mock Even G1 Right",
        address: "mock-right",
      },
    };
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

  onWifiStatus(callback: (status: SmartglassesWifiResult) => void): () => void {
    this.wifiCallbacks.add(callback);
    return () => this.wifiCallbacks.delete(callback);
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

  emitWifiStatus(status: SmartglassesWifiResult): void {
    for (const callback of this.wifiCallbacks) callback(status);
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

  async requestWifiSetup(reason?: string): Promise<SmartglassesWifiResult> {
    this.wifiRequests.push({ op: "setup", reason });
    return {
      ...this.wifiResult,
      status: "mock Wi-Fi setup requested",
    };
  }

  supportsWifi(): boolean {
    return true;
  }
}
