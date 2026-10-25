/**
 * Public ad-click tracking endpoint (SSP, #10687).
 *
 * POST /api/v1/marketing/inventory/click  { slot, impression_id }
 *
 * Records a click against a prior impression (idempotent on the impression id;
 * the impression must belong to the supplied slot). Public — the unguessable
 * impression id returned by serve is the capability — behind a STRICT IP-keyed
 * rate limit (cf-connecting-ip; clicks are rare human actions).
 */

import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { adInventoryService } from "@elizaos/cloud-shared/lib/services/ad-inventory";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit({ ...RateLimitPresets.STRICT, keyGenerator: getIpKey }));

app.post("/", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      slot?: string;
      impression_id?: string;
    };
    const slotId = body.slot?.trim();
    const impressionId = body.impression_id?.trim();
    if (!slotId || !impressionId) {
      return c.json(
        { success: false, error: "Missing slot or impression_id" },
        400,
      );
    }
    const recorded = await adInventoryService.recordClick(slotId, impressionId);
    return c.json({ success: true, recorded });
  } catch (error) {
    logger.error("[Ad Inventory API] click failed:", error);
    return c.json({ success: false, error: "Click failed" }, 500);
  }
});

export default app;
