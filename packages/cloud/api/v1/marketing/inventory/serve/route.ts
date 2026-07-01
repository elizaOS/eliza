/**
 * Public ad-serve decision endpoint (SSP, #10687).
 *
 * GET /api/v1/marketing/inventory/serve?slot=<slotId>&token=<adTagToken>
 *
 * Fills the slot with an eligible ad: picks an active campaign creative with
 * budget (not the publisher's own), debits the advertiser (exactly once,
 * bounded by the campaign's remaining budget), and settles the publisher's
 * earnings (idempotent on the returned impression id). Returns 204 when
 * nothing is eligible / the slot is paused.
 *
 * Abuse boundary — this endpoint moves money, so public access is gated:
 *   - a signed ad-tag token (HMAC over slot id + app id + expiry, minted for
 *     the publisher on the authenticated slot routes) is REQUIRED; a bare
 *     slot id cannot generate paid impressions. Fails closed when
 *     `ELIZA_AD_TAG_SECRET` is unset.
 *   - IP-keyed rate limit (cf-connecting-ip — a forged XFF cannot evade it).
 */

import { Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { adInventoryService } from "@/lib/services/ad-inventory";
import { verifyAdTagToken } from "@/lib/services/ad-tag-token";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.get("/", async (c) => {
  try {
    const slotId = c.req.query("slot")?.trim();
    const token = c.req.query("token")?.trim();
    if (!slotId) return c.json({ success: false, error: "Missing slot" }, 400);
    if (!token) {
      return c.json({ success: false, error: "Missing ad tag token" }, 401);
    }

    const slot = await adInventoryService.getSlot(slotId);
    if (!slot) return c.json({ success: false, error: "Slot not found" }, 404);

    const authorized = await verifyAdTagToken(token, {
      slotId: slot.id,
      appId: slot.app_id,
    });
    if (!authorized) {
      return c.json({ success: false, error: "Invalid ad tag token" }, 403);
    }

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
