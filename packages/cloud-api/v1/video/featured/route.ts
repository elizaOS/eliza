/**
 * GET /api/v1/video/featured
 * Returns the caller's most recent completed video, formatted for the
 * Video Studio "featured video" slot. Returns `{ video: null }` when the
 * caller has no completed videos yet.
 */

import { Hono } from "hono";
import { generationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";

type VideoStatus = "completed" | "processing" | "failed";

interface FeaturedVideo {
  id: string;
  prompt: string;
  modelId: string;
  thumbnailUrl: string;
  videoUrl?: string;
  createdAt: string;
  status: VideoStatus;
  durationSeconds?: number;
  resolution?: string;
}

interface FeaturedVideoResponse {
  video: FeaturedVideo | null;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);

  const completed = await generationsRepository.listByOrganizationAndStatusSummary(
    user.organization_id,
    "completed",
    { userId: user.id, type: "video", limit: 1 },
  );

  const latest = completed[0];
  if (!latest || !latest.storage_url) {
    const empty: FeaturedVideoResponse = { video: null };
    return c.json(empty);
  }

  const width = latest.dimensions?.width;
  const height = latest.dimensions?.height;
  const resolution = width && height ? `${width} × ${height}` : undefined;

  const video: FeaturedVideo = {
    id: latest.id,
    prompt: latest.prompt_preview,
    modelId: latest.model,
    thumbnailUrl: latest.thumbnail_url ?? latest.storage_url,
    videoUrl: latest.storage_url,
    createdAt: latest.created_at.toISOString(),
    status: "completed",
    durationSeconds: latest.dimensions?.duration,
    resolution,
  };

  const body: FeaturedVideoResponse = { video };
  return c.json(body);
});

app.onError((error, c) => failureResponse(c, error));

export default app;
