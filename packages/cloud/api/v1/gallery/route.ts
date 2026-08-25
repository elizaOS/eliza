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
import { parsePaginationParam } from "../pagination";

const galleryQuerySchema = z.object({
  type: z.enum(["image", "video"]).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const limitResult = parsePaginationParam(
      c.req.query("limit"),
      "limit",
      100,
    );
    if (!limitResult.ok) {
      return c.json({ error: limitResult.error }, 400);
    }
    const offsetResult = parsePaginationParam(
      c.req.query("offset"),
      "offset",
      0,
    );
    if (!offsetResult.ok) {
      return c.json({ error: offsetResult.error }, 400);
    }
    const limit = limitResult.value;
    const offset = offsetResult.value;
    const parsedQuery = galleryQuerySchema.safeParse({
      type: c.req.query("type") || undefined,
    });

    if (!parsedQuery.success) {
      return c.json(
        { error: "Validation error", details: parsedQuery.error.issues },
        400,
      );
    }

    const { type } = parsedQuery.data;

    const fetchLimit = limit + 1;
    const allGenerations =
      await generationsService.listByOrganizationAndStatusSummary(
        user.organization_id,
        "completed",
        {
          userId: user.id,
          type,
          requireStorageUrl: true,
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
