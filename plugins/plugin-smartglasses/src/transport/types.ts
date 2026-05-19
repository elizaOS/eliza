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
}

export interface SmartglassesTransportFactory {
  create(): SmartglassesTransport | null;
}
