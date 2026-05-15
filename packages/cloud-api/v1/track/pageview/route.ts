/**
 * POST /api/v1/track/pageview
 * Lightweight page-view ingestion for sandbox / embedded apps.
 * Accepts API key in header (`x-api-key`) or `api_key` in body (sendBeacon-friendly).
 */

import { Hono } from "hono";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

function detectSource(origin: string, referer: string, pageUrl: string): string {
  const combined = `${origin} ${referer} ${pageUrl}`.toLowerCase();
  if (
    combined.includes("sandbox") ||
    combined.includes("localhost") ||
    combined.includes("127.0.0.1") ||
    combined.includes("eliza.gg") ||
    combined.includes(".dev.") ||
    combined.includes("-preview")
  ) {
    return "sandbox_preview";
  }
  return "embed";
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.post("/", async (c) => {
  const startTime = Date.now();
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const {
      app_id,
      api_key: bodyApiKey,
      page_url,
      referrer,
      screen_width,
      screen_height,
      pathname,
    } = body as {
      app_id?: string;
      api_key?: string;
      page_url?: string;
      referrer?: string;
      screen_width?: number;
      screen_height?: number;
      pathname?: string;
    };

    const apiKey = c.req.header("x-api-key") || bodyApiKey;
    const ipAddress =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    const userAgent = c.req.header("user-agent") || "unknown";
    const origin = c.req.header("origin") || "";
    const referer = c.req.header("referer") || "";

    let appId = app_id;
    if (!appId && apiKey) {
      const validatedKey = await apiKeysService.validateApiKey(apiKey);
      if (validatedKey) {
        const appRow = await appsService.getByApiKeyId(validatedKey.id);
        if (appRow) appId = appRow.id;
      }
    }

    if (!appId) {
      return c.json({ success: false, error: "Missing app_id or valid API key" }, 400);
    }

    const appRow = await appsService.getById(appId);
    if (!appRow) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    const pageUrlValue = page_url || pathname || "/";
    const source = detectSource(origin, referer, pageUrlValue);

    await appsService.trackPageView(appId, {
      pageUrl: pageUrlValue,
      referrer: referrer || referer,
      ipAddress,
      userAgent,
      source,
      metadata: { screen_width, screen_height, origin, referer, pathname },
    });

    logger.debug("[Track] Page view recorded", {
      appId,
      pageUrl: pageUrlValue,
      source,
      responseTimeMs: Date.now() - startTime,
    });

    return c.json({ success: true });
  } catch (error) {
    logger.error("[Track] Failed to record page view:", error);
    return c.json({ success: false, error: "Failed to track page view" }, 500);
  }
});

export default app;
