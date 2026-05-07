import { useQuery } from "@tanstack/react-query";
import type { GalleryItem } from "@/lib/types/gallery";
import type {
  GeneratedVideo,
  VideoGenerationStatus,
  VideoUsageSummary,
} from "../../dashboard/video/_components/types";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

interface FeaturedVideoResponseRaw {
  video: {
    id: string;
    prompt: string;
    modelId: string;
    thumbnailUrl: string;
    videoUrl?: string;
    createdAt: string;
    status: VideoGenerationStatus;
    durationSeconds?: number;
    resolution?: string;
  } | null;
}

/** GET /api/v1/video/usage — caller's video usage rollup. */
export function useVideoUsage() {
  const gate = useAuthenticatedQueryGate();
  return useQuery<VideoUsageSummary>({
    queryKey: authenticatedQueryKey(["video", "usage"], gate),
    queryFn: () => api<VideoUsageSummary>("/api/v1/video/usage"),
    enabled: gate.enabled,
  });
}

/** GET /api/v1/video/featured — caller's most recent completed video, or null. */
export function useFeaturedVideo() {
  const gate = useAuthenticatedQueryGate();
  return useQuery<GeneratedVideo | null>({
    queryKey: authenticatedQueryKey(["video", "featured"], gate),
    queryFn: async () => {
      const data = await api<FeaturedVideoResponseRaw>("/api/v1/video/featured");
      if (!data.video) return null;
      const { video } = data;
      return {
        id: video.id,
        prompt: video.prompt,
        modelId: video.modelId,
        thumbnailUrl: video.thumbnailUrl,
        videoUrl: video.videoUrl,
        createdAt: video.createdAt,
        status: video.status,
        durationSeconds: video.durationSeconds,
        resolution: video.resolution,
      };
    },
    enabled: gate.enabled,
  });
}

const VIDEO_STATUS_MAP: Record<string, VideoGenerationStatus> = {
  completed: "completed",
  pending: "processing",
  processing: "processing",
  failed: "failed",
};

function toVideoStatus(status: string): VideoGenerationStatus {
  return VIDEO_STATUS_MAP[status] ?? "processing";
}

/**
 * Adapter: translate a `GalleryItem` (transport DTO from /api/v1/gallery) into
 * the `GeneratedVideo` shape the Video Studio expects. Used to feed
 * `recentVideos` from `useGallery({ type: "video" })` without a parallel
 * endpoint.
 */
export function galleryItemToGeneratedVideo(item: GalleryItem): GeneratedVideo {
  const width = item.dimensions?.width;
  const height = item.dimensions?.height;
  const resolution = width && height ? `${width} × ${height}` : undefined;

  return {
    id: item.id,
    prompt: item.prompt,
    modelId: item.model,
    thumbnailUrl: item.thumbnailUrl ?? item.url,
    videoUrl: item.url,
    createdAt: item.createdAt.toISOString(),
    status: toVideoStatus(item.status),
    durationSeconds: item.dimensions?.duration,
    resolution,
  };
}
