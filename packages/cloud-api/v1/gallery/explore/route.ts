/**
 * GET /api/v1/gallery/explore
 *
 * Public endpoint — lists random public images from across the platform for
 * the explore/discover section.
 *
 * Mirrors `_legacy_actions/gallery.ts → listExploreImages`.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { generationsService } from "@/lib/services/generations";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.get("/", async (c) => {
  try {
    const limitParam = c.req.query("limit");
    const parsed = limitParam ? Number.parseInt(limitParam, 10) : 20;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;

    const generations = await generationsService.listRandomPublicImageSummaries(limit);

    const items = generations.map((gen) => ({
      id: gen.id,
      type: gen.type as "image" | "video",
      url: gen.storage_url,
      thumbnailUrl: gen.thumbnail_url || undefined,
      prompt: gen.prompt_preview,
      model: gen.model,
      status: gen.status,
      createdAt: gen.created_at,
      completedAt: gen.completed_at || undefined,
      dimensions: gen.dimensions || undefined,
      mimeType: gen.mime_type || undefined,
      fileSize: gen.file_size?.toString(),
    }));

    return c.json({ items });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
