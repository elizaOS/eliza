/**
 * Influencer marketplace — bookings (#10687).
 *
 * GET  /api/v1/marketing/influencers/bookings                — bookings the org
 *   is party to (as advertiser); `?as=influencer` for ones you were booked for
 * POST /api/v1/marketing/influencers/bookings                — fund an offer
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { influencerMarketplaceService } from "@/lib/services/influencer-marketplace";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CreateBookingSchema = z.object({
  profileId: z.string().uuid(),
  brief: z.string().min(1).max(4000),
  amount: z.number().positive().max(1_000_000),
  /** Optional create key: a retry with the same key returns the original booking instead of funding twice. */
  idempotencyKey: z.string().min(8).max(255).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const bookings =
      c.req.query("as") === "influencer"
        ? await influencerMarketplaceService.listBookingsForInfluencer(user.id)
        : await influencerMarketplaceService.listBookingsForOrg(
            user.organization_id,
          );
    return c.json({ success: true, bookings });
  } catch (error) {
    logger.error("[Influencer API] list bookings failed:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = CreateBookingSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.flatten(),
        },
        400,
      );
    }
    const result = await influencerMarketplaceService.createBooking({
      advertiserOrgId: user.organization_id,
      profileId: parsed.data.profileId,
      brief: parsed.data.brief,
      amount: parsed.data.amount,
      createdByUserId: user.id,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (!result.ok) return c.json({ success: false, error: result.error }, 402);
    return c.json({ success: true, booking: result.booking }, 201);
  } catch (error) {
    logger.error("[Influencer API] create booking failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
