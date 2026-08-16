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
});

function parsePaginationParam(
  rawValue: string | undefined,
  parameter: "limit" | "offset",
  defaultValue: number,
): number | string {
  const value = rawValue?.trim();
  if (!value) return defaultValue;

  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return `Invalid ${parameter} ${JSON.stringify(
      rawValue,
    )}: expected a canonical decimal integer`;
  }

  const parsed = Number(value);
  const maximum = parameter === "limit" ? 500 : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (parameter === "limit" ? 1 : 0) ||
    parsed > maximum
  ) {
    const bounds =
      parameter === "limit"
        ? "between 1 and 500"
        : "greater than or equal to 0";
    return `Invalid ${parameter} ${JSON.stringify(
      rawValue,
    )}: expected an integer ${bounds}`;
  }

  return parsed;
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const limit = parsePaginationParam(c.req.query("limit"), "limit", 100);
    if (typeof limit === "string") {
      return c.json({ error: limit }, 400);
    }
    const offset = parsePaginationParam(c.req.query("offset"), "offset", 0);
    if (typeof offset === "string") {
      return c.json({ error: offset }, 400);
    }
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
