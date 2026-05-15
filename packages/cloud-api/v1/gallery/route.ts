/**
 * GET /api/v1/gallery
 * Lists all media (images and videos) for the authenticated user's organization.
 * Supports filtering by type and pagination.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const galleryQuerySchema = z.object({
  type: z.enum(["image", "video"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const parsedQuery = galleryQuerySchema.safeParse({
      type: c.req.query("type") || undefined,
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
    });

    if (!parsedQuery.success) {
      return c.json({ error: "Validation error", details: parsedQuery.error.issues }, 400);
    }

    const { type, limit, offset } = parsedQuery.data;

    const fetchLimit = Math.min(limit + 1, 1001);
    const allGenerations = await generationsService.listByOrganizationAndStatusSummary(
      user.organization_id,
      "completed",
      {
        userId: user.id,
        type,
        limit: fetchLimit,
        offset,
      },
    );

    const generations = allGenerations.filter((gen) => gen.storage_url);
    const visibleGenerations = generations.slice(0, limit);

    const items = visibleGenerations.map((gen) => ({
      id: gen.id,
      type: gen.type,
      url: gen.storage_url,
      thumbnailUrl: gen.thumbnail_url,
      prompt: gen.prompt_preview,
      negativePrompt: gen.negative_prompt_preview,
      model: gen.model,
      provider: gen.provider,
      status: gen.status,
      createdAt: gen.created_at.toISOString(),
      completedAt: gen.completed_at?.toISOString(),
      dimensions: gen.dimensions,
      mimeType: gen.mime_type,
      fileSize: gen.file_size?.toString(),
      metadata: gen.metadata,
    }));

    return c.json({
      items,
      count: items.length,
      offset,
      limit,
      hasMore: generations.length > limit,
    });
  } catch (error) {
    logger.error("[GALLERY API] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
