/**
 * Public first-party conversion pixel/webhook endpoint (#11598).
 *
 * GET  /api/v1/advertising/conversions/track?token=...&dedupeKey=...
 * POST /api/v1/advertising/conversions/track
 *
 * The signed token identifies the campaign/app/org. The dedupe key is required
 * and is unique per campaign + event type, so replays do not double-count.
 */

import { type Context, Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { advertisingService } from "@/lib/services/advertising";
import { RecordConversionSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

function requestContext(c: Context<AppEnv>) {
  return {
    userAgent: c.req.header("user-agent") || undefined,
    referrer: c.req.header("referer") || c.req.header("referrer") || undefined,
  };
}

function presentMetadata(input: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

/**
 * Canonical decimal conversion amounts only. Number("1e2") === 100 used to
 * become a real tracked value on the public pixel query string.
 */
export function parseConversionQueryValue(
  raw: string | undefined,
): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(raw)) return "invalid";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

app.get("/", async (c) => {
  try {
    const token = c.req.query("token");
    const dedupeKey = c.req.query("dedupeKey") ?? c.req.query("eventId");
    const eventType = c.req.query("eventType") ?? "conversion";
    const value = parseConversionQueryValue(c.req.query("value"));
    if (value === "invalid") {
      return c.json({ success: false, error: "Invalid conversion event" }, 400);
    }
    const sourceUrl = c.req.query("sourceUrl");
    const parsed = RecordConversionSchema.safeParse({
      token,
      dedupeKey,
      eventType,
      value,
      currency: c.req.query("currency") ?? "USD",
      sourceUrl,
      metadata: presentMetadata({
        utmSource: c.req.query("utm_source"),
        utmMedium: c.req.query("utm_medium"),
        utmCampaign: c.req.query("utm_campaign"),
        utmContent: c.req.query("utm_content"),
        utmTerm: c.req.query("utm_term"),
      }),
      ...requestContext(c),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid conversion event",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    await advertisingService.recordConversion({
      ...parsed.data,
      occurredAt: parsed.data.occurredAt
        ? new Date(parsed.data.occurredAt)
        : undefined,
    });
    return c.body(null, 204);
  } catch (error) {
    logger.warn("[Advertising API] Conversion pixel rejected", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: "Conversion rejected" }, 403);
  }
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = RecordConversionSchema.safeParse({
      ...(body as Record<string, unknown>),
      ...requestContext(c),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid conversion event",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const result = await advertisingService.recordConversion({
      ...parsed.data,
      occurredAt: parsed.data.occurredAt
        ? new Date(parsed.data.occurredAt)
        : undefined,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.warn("[Advertising API] Conversion webhook rejected", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: "Conversion rejected" }, 403);
  }
});

export default app;
