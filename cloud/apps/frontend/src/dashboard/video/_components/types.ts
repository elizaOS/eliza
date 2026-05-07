export type VideoGenerationStatus = "completed" | "processing" | "failed";

export interface VideoModelOption {
  id: string;
  label: string;
  description: string;
  durationEstimate: string;
  dimensions: string;
}

export interface GeneratedVideo {
  id: string;
  prompt: string;
  modelId: string;
  thumbnailUrl: string;
  videoUrl?: string;
  createdAt: string;
  status: VideoGenerationStatus;
  durationSeconds?: number;
  resolution?: string;
  seed?: number;
  requestId?: string;
  referenceUrl?: string;
  timings?: Record<string, number> | null;
  hasNsfwConcepts?: boolean[];
  failureReason?: string;
  isMock?: boolean;
}

export interface VideoUsageSummary {
  totalRenders: number;
  monthlyCredits: number;
  averageDuration: number;
  lastGeneration?: string;
}
