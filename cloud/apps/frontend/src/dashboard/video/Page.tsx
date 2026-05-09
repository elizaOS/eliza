import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useGallery } from "../../lib/data/gallery";
import { galleryItemToGeneratedVideo, useFeaturedVideo, useVideoUsage } from "../../lib/data/video";
import type { VideoModelOption } from "./_components/types";
import { VideoPageClient } from "./_components/video-page-client";

const MODEL_PRESETS: VideoModelOption[] = [
  {
    id: "fal-ai/veo3",
    label: "Google Veo 3",
    description: "State-of-the-art video generation with 1080p quality and audio support.",
    durationEstimate: "5-10s",
    dimensions: "1920 × 1080",
  },
  {
    id: "fal-ai/kling-video/v3/pro/text-to-video",
    label: "Kling 3 Pro",
    description: "Top-tier text-to-video with fluid motion and cinematic visuals.",
    durationEstimate: "5-10s",
    dimensions: "1920 × 1080",
  },
  {
    id: "fal-ai/minimax/hailuo-2.3/standard/text-to-video",
    label: "MiniMax Hailuo 2.3 Standard",
    description: "Cost-effective video generation with 768p resolution.",
    durationEstimate: "6-10s",
    dimensions: "1280 × 768",
  },
];

export default function VideoPage() {
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;

  const usageQuery = useVideoUsage();
  const featuredQuery = useFeaturedVideo();
  const galleryQuery = useGallery(enabled ? { type: "video" } : undefined);

  const recentVideos = useMemo(
    () => (galleryQuery.data ?? []).map(galleryItemToGeneratedVideo),
    [galleryQuery.data],
  );

  const isLoading =
    !session.ready ||
    (enabled && (usageQuery.isLoading || featuredQuery.isLoading || galleryQuery.isLoading));

  const error = usageQuery.error ?? featuredQuery.error ?? galleryQuery.error;

  return (
    <>
      <Helmet>
        <title>Video Studio</title>
        <meta
          name="description"
          content="Generate and manage AI videos with the Eliza Cloud video studio"
        />
      </Helmet>
      {isLoading ? (
        <DashboardLoadingState label="Loading video studio" />
      ) : error ? (
        <DashboardErrorState message={(error as Error).message} />
      ) : usageQuery.data ? (
        <VideoPageClient
          modelPresets={MODEL_PRESETS}
          featuredVideo={featuredQuery.data ?? null}
          usage={usageQuery.data}
          recentVideos={recentVideos}
        />
      ) : null}
    </>
  );
}
