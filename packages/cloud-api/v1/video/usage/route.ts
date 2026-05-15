/**
 * GET /api/v1/video/usage
 * Aggregate usage summary for the caller's video generations.
 */

import { Hono } from "hono";
import { generationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { generationsService } from "@/lib/services/generations";
import type { AppEnv } from "@/types/cloud-worker-env";

interface VideoUsageResponse {
  totalRenders: number;
  monthlyCredits: number;
  averageDuration: number;
  lastGeneration?: string;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthlyStats = await generationsService.getStats(user.organization_id, monthStart, now);
  const monthlyVideoStats = monthlyStats.byType.find((entry) => entry.type === "video");
  const monthlyCredits = monthlyVideoStats ? Math.round(monthlyVideoStats.totalCredits) : 0;

  const completedVideos = await generationsRepository.listByOrganizationAndStatusSummary(
    user.organization_id,
    "completed",
    { userId: user.id, type: "video" },
  );

  const totalRenders = completedVideos.length;

  const durations = completedVideos
    .map((gen) => gen.dimensions?.duration)
    .filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  const averageDuration =
    durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;

  const lastGenerationDate = completedVideos[0]?.completed_at ?? completedVideos[0]?.created_at;

  const body: VideoUsageResponse = {
    totalRenders,
    monthlyCredits,
    averageDuration,
    lastGeneration: lastGenerationDate ? lastGenerationDate.toISOString() : undefined,
  };

  return c.json(body);
});

app.onError((error, c) => failureResponse(c, error));

export default app;
