/**
 * Shared type definitions for Voice features
 */

export interface Voice {
  id: string;
  elevenlabsVoiceId: string;
  name: string;
  description: string | null;
  cloneType: "instant" | "professional";
  sampleCount: number;
  usageCount: number;
  isActive: boolean;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  audioQualityScore: string | null;
  totalAudioDurationSeconds: number | null;
}

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

export interface VoiceCloneJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  error?: string;
}
