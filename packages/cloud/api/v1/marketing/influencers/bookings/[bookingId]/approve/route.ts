/** POST /api/v1/marketing/influencers/bookings/:bookingId/approve — advertiser approves + releases escrow (#10687). */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { influencerMarketplaceService } from "@/lib/services/influencer-marketplace";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("bookingId");
    if (!id)
      return c.json({ success: false, error: "Missing booking id" }, 400);
    const result = await influencerMarketplaceService.approveBooking(
      id,
      user.organization_id,
    );
    if (!result.ok) return c.json({ success: false, error: result.error }, 409);
    return c.json({ success: true, booking: result.booking });
  } catch (error) {
    logger.error("[Influencer API] approve failed:", error);
    return failureResponse(c, error);
  }
});
export default app;
