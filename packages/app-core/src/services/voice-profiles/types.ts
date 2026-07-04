/**
 * Shared data contracts for the voice-profiles subsystem: an embedding summary,
 * per-profile quality metrics, the `VoiceProfile` record (owner flag,
 * embeddings, consent basis), a diarization segment, the owner-confidence
 * result, and the owner-challenge record. Consumed across the store, nickname
 * evaluator, confidence scorer, and challenge service.
 */
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
