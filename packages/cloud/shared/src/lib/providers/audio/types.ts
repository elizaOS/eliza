import type { Bindings } from "../../../types/cloud-worker-env";

export type AudioProviderId = "fal" | "elevenlabs" | "suno";

export interface AudioGenerationRequest {
  prompt: string;
  model: string;
  lyrics?: string;
  lyricsOptimizer?: boolean;
  instrumental?: boolean;
  durationSeconds?: number;
  referenceUrl?: string;
  seed?: number;
  outputFormat?: string;
  audio?: {
    format?: "mp3" | "wav" | "pcm" | "flac";
    sampleRate?: "16000" | "24000" | "32000" | "44100";
    bitrate?: "32000" | "64000" | "128000" | "256000";
  };
  extraInput?: Record<string, unknown>;
}

export interface AudioGenerationUser {
  id: string;
  organization_id?: string | null;
}

export interface AudioObject {
  url?: string;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

export interface AudioGenerationResult {
  requestId?: string;
  status?: string;
  audio: AudioObject;
  raw?: unknown;
}

export interface AudioProviderGenerateInput {
  env: Bindings;
  request: AudioGenerationRequest;
  user: AudioGenerationUser;
}

export interface AudioProvider {
  billingSource: AudioProviderId;
  generate(input: AudioProviderGenerateInput): Promise<AudioGenerationResult>;
  healthCheck?(): Promise<boolean>;
}
