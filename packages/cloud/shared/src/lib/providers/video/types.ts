import type { PricingBillingSource } from "../../services/ai-pricing-definitions";

export interface VideoGenerationRequest {
  model: string;
  prompt: string;
  referenceUrl?: string;
  durationSeconds?: number;
  resolution?: string;
  audio?: boolean;
  voiceControl?: boolean;
  apiKeys: Record<string, string | undefined>;
}

export interface GeneratedVideoObject {
  url: string;
  width?: number;
  height?: number;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

export interface GeneratedVideo {
  requestId?: string;
  video: GeneratedVideoObject;
  seed?: number;
  timings?: Record<string, number> | null;
  hasNsfwConcepts?: boolean[];
}

export interface VideoProvider {
  billingSource: PricingBillingSource;
  isConfigured?(apiKeys: Record<string, string | undefined>): boolean;
  generate(req: VideoGenerationRequest): Promise<GeneratedVideo>;
  healthCheck?(): Promise<boolean>;
}
