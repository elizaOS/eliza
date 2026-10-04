/**
 * POST /api/v1/marketing/influencers/bookings/:bookingId/reject — reject + refund (#10687).
 *
 * Role-aware: the booked influencer declines an offer; the advertiser rejects a
 * submitted deliverable. Either way the advertiser's escrow is refunded (gated
 * by the booking-status CAS).
 */

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

    const booking = await influencerMarketplaceService.getBooking(id);
    if (!booking)
      return c.json({ success: false, error: "Booking not found" }, 404);

    let result: Awaited<
      ReturnType<typeof influencerMarketplaceService.rejectBooking>
    >;
    if (booking.influencer_user_id === user.id) {
      result = await influencerMarketplaceService.rejectBooking(id, user.id);
    } else if (booking.advertiser_org_id === user.organization_id) {
      result = await influencerMarketplaceService.rejectDeliverable(
        id,
        user.organization_id,
      );
    } else {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (!result.ok) return c.json({ success: false, error: result.error }, 409);
    return c.json({ success: true, booking: result.booking });
  } catch (error) {
    logger.error("[Influencer API] reject failed:", error);
    return failureResponse(c, error);
  }
});
export default app;
