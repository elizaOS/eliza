/**
 * Public ad-serve decision endpoint (SSP, #10687).
 *
 * GET /api/v1/marketing/inventory/serve?slot=<slotId>
 *
 * Fills the slot with an eligible ad: picks an active campaign creative with
 * budget (not the publisher's own), debits the advertiser (exactly once), and
 * credits the publisher's earnings (idempotent on the returned impression id).
 * Returns 204 when nothing is eligible / the slot is paused. Public + rate
 * limited — consumed by the miniapp's ad tag.
 */

import { Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { adInventoryService } from "@/lib/services/ad-inventory";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.get("/", async (c) => {
  try {
    const slotId = c.req.query("slot")?.trim();
    if (!slotId) return c.json({ success: false, error: "Missing slot" }, 400);

    const slot = await adInventoryService.getSlot(slotId);
    if (!slot) return c.json({ success: false, error: "Slot not found" }, 404);

    const served = await adInventoryService.serveAd(slot);
    if (!served) return c.body(null, 204); // no fill

    return c.json({
      success: true,
      ad: {
        impressionId: served.impressionId,
        headline: served.headline,
        body: served.primaryText,
        callToAction: served.callToAction,
        destinationUrl: served.destinationUrl,
        media: served.media,
      },
    });
  } catch (error) {
    logger.error("[Ad Inventory API] serve failed:", error);
    return c.json({ success: false, error: "Serve failed" }, 500);
  }
});

export default app;
