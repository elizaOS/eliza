import type {
  G1Event,
  GlassSide,
  SmartglassesAudioEncoding,
} from "../protocol.js";

export interface SmartglassesTransport {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  write(side: GlassSide, data: Uint8Array): Promise<void>;
  writeBoth(data: Uint8Array): Promise<void>;
  openMicrophone(enabled: boolean): Promise<void>;
  onEvent(callback: (event: G1Event) => void): () => void;
  onAudio(
    callback: (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void,
  ): () => void;
  onTranscript?(
    callback: (
      text: string,
      isFinal: boolean,
      metadata?: Record<string, unknown>,
    ) => void,
  ): () => void;
  scanWifi?(): Promise<SmartglassesWifiResult>;
  getWifiStatus?(): Promise<SmartglassesWifiResult>;
  configureWifi?(
    ssid: string,
    password: string,
  ): Promise<SmartglassesWifiResult>;
  requestWifiSetup?(reason?: string): Promise<SmartglassesWifiResult>;
  supportsWifi?(): boolean;
  getConnectedLenses?(): SmartglassesConnectedLenses;
}

export interface SmartglassesTransportFactory {
  create(): SmartglassesTransport | null;
}

export interface SmartglassesWifiResult {
  available: boolean;
  status: string;
  networks: string[];
  raw?: unknown;
}

export interface SmartglassesLensConnection {
  connected: boolean;
  name?: string;
  address?: string;
}

export type SmartglassesConnectedLenses = Partial<
  Record<GlassSide, SmartglassesLensConnection>
>;
