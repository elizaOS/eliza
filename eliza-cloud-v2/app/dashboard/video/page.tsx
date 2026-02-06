import type { Metadata } from "next";

import { VideoPageClient } from "@/components/video/video-page-client";
import type {
  GeneratedVideo,
  VideoModelOption,
  VideoUsageSummary,
} from "@/components/video/types";
import { generatePageMetadata, ROUTE_METADATA } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = generatePageMetadata({
  ...ROUTE_METADATA.videoGeneration,
  path: "/dashboard/video",
  noIndex: true,
});

const modelPresets: VideoModelOption[] = [
  {
    id: "fal-ai/veo3",
    label: "Google Veo 3",
    description:
      "State-of-the-art video generation with 1080p quality and audio support.",
    durationEstimate: "5-10s",
    dimensions: "1920 × 1080",
  },
  {
    id: "fal-ai/kling-video/v2.1/master/text-to-video",
    label: "Kling 2.1 Master",
    description:
      "Top-tier text-to-video with unparalleled motion fluidity and cinematic visuals.",
    durationEstimate: "5-10s",
    dimensions: "1920 × 1080",
  },
  {
    id: "fal-ai/minimax/hailuo-02/standard/text-to-video",
    label: "MiniMax Hailuo-02 Standard",
    description: "Cost-effective video generation with 768p resolution.",
    durationEstimate: "6-10s",
    dimensions: "1280 × 768",
  },
];

const featuredVideo: GeneratedVideo = {
  id: "vd_903c",
  prompt:
    "A neon-lit hovercar weaving through a layered cyberpunk skyline during golden hour",
  modelId: "fal-ai/veo3",
  thumbnailUrl:
    "https://images.unsplash.com/photo-1520350094755-0e30f98c70b0?auto=format&fit=crop&w=1600&q=80",
  videoUrl: "https://video-placeholder.eliza.ai/veo3-hovercar.mp4",
  createdAt: new Date().toISOString(),
  status: "completed",
  durationSeconds: 8,
  resolution: "1920 × 1080",
  seed: 3489,
  requestId: "req_vd_903c",
  referenceUrl: "https://images.unsplash.com/photo-1502877338535-766e1452684a",
  timings: { inference: 7800, total: 10100 },
  hasNsfwConcepts: [false],
};

const usageSummary: VideoUsageSummary = {
  totalRenders: 148,
  monthlyCredits: 72,
  averageDuration: 8.6,
  lastGeneration: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
};

const recentVideos: GeneratedVideo[] = [
  featuredVideo,
  {
    id: "vd_903b",
    prompt: "A macro shot of morning dew forming on bioluminescent leaves",
    modelId: "fal-ai/kling-video/v2.1/master/text-to-video",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1501004318641-b39e6451bec6?auto=format&fit=crop&w=1600&q=80",
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    status: "processing",
    durationSeconds: undefined,
    resolution: "1920 × 1080",
    seed: 2191,
    requestId: "req_vd_903b",
    referenceUrl:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee",
  },
  {
    id: "vd_903a",
    prompt:
      "Product carousel with floating glass smartwatch over soft studio lighting",
    modelId: "fal-ai/minimax/hailuo-02/standard/text-to-video",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1523475472560-d2df97ec485c?auto=format&fit=crop&w=1600&q=80",
    createdAt: new Date(Date.now() - 1000 * 60 * 220).toISOString(),
    status: "completed",
    durationSeconds: 7,
    resolution: "1280 × 768",
    seed: 5901,
    requestId: "req_vd_903a",
    timings: { inference: 6800 },
    hasNsfwConcepts: [false],
  },
  {
    id: "vd_902z",
    prompt:
      "Slow motion desert landscape with sculpted sandstone pillars at dusk",
    modelId: "fal-ai/veo3",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=1600&q=80",
    createdAt: new Date(Date.now() - 1000 * 60 * 420).toISOString(),
    status: "failed",
    durationSeconds: 0,
    resolution: "1920 × 1080",
    seed: 7312,
    requestId: "req_vd_902z",
    failureReason: "Upstream request timed out after 120s",
  },
];

/**
 * Video Generation page for creating AI-generated videos.
 * Displays model presets, featured video, usage statistics, and recent videos.
 *
 * @returns The rendered video generation page client component.
 */
export default function VideoPage() {
  return (
    <VideoPageClient
      modelPresets={modelPresets}
      featuredVideo={featuredVideo}
      usage={usageSummary}
      recentVideos={recentVideos}
    />
  );
}
