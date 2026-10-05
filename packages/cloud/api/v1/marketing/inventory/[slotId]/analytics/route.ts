/**
 * Ad slot analytics (#10687).
 *
 * GET /api/v1/marketing/inventory/:slotId/analytics — impressions/clicks/revenue
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { adInventoryService } from "@elizaos/cloud-shared/lib/services/ad-inventory";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
