import type { DiarizationSegment } from "./types.ts";

export interface DiarizationPipeline {
  diarize(audioRef: string): Promise<DiarizationSegment[]>;
}

export const MOCK_DIARIZATION_PIPELINE: DiarizationPipeline = {
  async diarize(audioRef: string): Promise<DiarizationSegment[]> {
    if (audioRef.length === 0) return [];
    return [
      { startMs: 0, endMs: 1_000, profileId: "mock-speaker-a", confidence: 0.8 },
      { startMs: 1_000, endMs: 2_000, profileId: "mock-speaker-b", confidence: 0.7 },
    ];
  },
};
