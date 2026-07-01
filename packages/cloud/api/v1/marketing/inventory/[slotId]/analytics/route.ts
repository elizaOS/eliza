/**
 * Ad slot analytics (#10687).
 *
 * GET /api/v1/marketing/inventory/:slotId/analytics — impressions/clicks/revenue
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { adInventoryService } from "@/lib/services/ad-inventory";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const slotId = c.req.param("slotId");
    if (!slotId)
      return c.json({ success: false, error: "Missing slot id" }, 400);
    const slot = await adInventoryService.getSlot(slotId);
    if (!slot) return c.json({ success: false, error: "Slot not found" }, 404);
    if (slot.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    const analytics = await adInventoryService.analytics(slotId);
    return c.json({ success: true, analytics });
  } catch (error) {
    logger.error("[Ad Inventory API] analytics failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
