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
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { generationsService } from "@/lib/services/generations";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_EXPLORE_LIMIT = 20;
const MAX_EXPLORE_LIMIT = 100;

class GalleryExploreLimitError extends Error {
  constructor(message = "Invalid limit") {
    super(message);
    this.name = "GalleryExploreLimitError";
  }
}

/**
 * GET /api/v1/gallery/explore `limit` is explore-page size identity,
 * leftover tax after v1 gallery list pagination. Stock develop used
 * parseClampedLimit, which treated `1e2` / `12px` / `007` / `foo` as
 * the default 20 instead of a 400. type / status stay untouched.
 * Missing / empty still means 20. Exact integers clamp at 100.
 */
function parseExploreLimitQuery(searchParams: URLSearchParams): number {
  const requested = searchParams.getAll("limit");
  if (requested.length > 1) {
    throw new GalleryExploreLimitError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return DEFAULT_EXPLORE_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new GalleryExploreLimitError();
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new GalleryExploreLimitError();
  }
  return Math.min(parsed, MAX_EXPLORE_LIMIT);
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.get("/", async (c) => {
  try {
    let limit: number;
    try {
      limit = parseExploreLimitQuery(new URL(c.req.url).searchParams);
    } catch (limitError) {
      if (limitError instanceof GalleryExploreLimitError) {
        return c.json({ error: limitError.message }, 400);
      }
      throw limitError;
    }

    const generations =
      await generationsService.listRandomPublicImageSummaries(limit);

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
