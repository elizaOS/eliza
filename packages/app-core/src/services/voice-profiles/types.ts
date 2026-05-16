export interface VoiceEmbeddingSummary {
  vectorPreview: ReadonlyArray<number>;
  modelId: string;
  createdAt: number;
}

export interface VoiceProfileQuality {
  samples: number;
  seconds: number;
  noiseFloor: number;
  lastUpdatedAt: number;
}

export interface VoiceProfile {
  id: string;
  displayName?: string;
  owner: boolean;
  embeddingModel: string;
  embeddings: VoiceEmbeddingSummary[];
  quality: VoiceProfileQuality;
  consent: "explicit" | "implicit-household" | "unknown";
}

export interface DiarizationSegment {
  startMs: number;
  endMs: number;
  profileId?: string;
  confidence: number;
}

export interface OwnerConfidence {
  score: number;
  reasons: string[];
}

export interface OwnerChallenge {
  id: string;
  prompt: string;
  expectedAnswerHash: string;
  createdAt: number;
  expiresAt: number;
}
