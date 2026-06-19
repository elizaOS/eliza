export interface Phrase {
  id: number;
  text: string;
  fromIndex: number;
  toIndex: number;
  terminator: "punctuation" | "max-cap" | "phoneme-stream";
}

export interface AudioChunk {
  phraseId: number;
  fromIndex: number;
  toIndex: number;
  pcm: Float32Array;
  sampleRate: number;
}

export interface SpeakerPreset {
  voiceId: string;
  embedding: Float32Array;
  bytes: Uint8Array;
  version?: number;
  refAudioTokens?: {
    K: number;
    refT: number;
    tokens: Int32Array;
  };
  refText?: string;
  instruct?: string;
  metadata?: Record<string, unknown>;
}

export interface OmniVoiceBackend {
  synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk>;
}

export interface TtsPcmChunk {
  pcm: Float32Array;
  sampleRate: number;
  isFinal: boolean;
}

export interface StreamingTtsBackend {
  synthesizeStream(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
    onKernelTick?: () => void;
  }): Promise<{ cancelled: boolean }>;
}
