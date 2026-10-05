/** POST /api/v1/marketing/influencers/bookings/:bookingId/cancel — advertiser cancels a pre-acceptance offer + refunds (#10687). */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { influencerMarketplaceService } from "@elizaos/cloud-shared/lib/services/influencer-marketplace";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("bookingId");
    if (!id)
      return c.json({ success: false, error: "Missing booking id" }, 400);
    const result = await influencerMarketplaceService.cancelBooking(
      id,
      user.organization_id,
    );
    if (!result.ok) return c.json({ success: false, error: result.error }, 409);
    return c.json({ success: true, booking: result.booking });
  } catch (error) {
    logger.error("[Influencer API] cancel failed:", error);
    return failureResponse(c, error);
  }
});
export default app;
