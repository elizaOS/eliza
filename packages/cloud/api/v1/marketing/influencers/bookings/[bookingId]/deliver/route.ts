/** POST /api/v1/marketing/influencers/bookings/:bookingId/deliver — influencer submits the deliverable (#10687). */
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { influencerMarketplaceService } from "@/lib/services/influencer-marketplace";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const Schema = z.object({ deliverableUrl: z.string().url().max(2000) });

const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("bookingId");
    if (!id)
      return c.json({ success: false, error: "Missing booking id" }, 400);
    const parsed = Schema.safeParse(await c.req.json().catch(() => ({})));
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
    const result = await influencerMarketplaceService.submitDeliverable(
      id,
      user.id,
      parsed.data.deliverableUrl,
    );
    if (!result.ok) return c.json({ success: false, error: result.error }, 409);
    return c.json({ success: true, booking: result.booking });
  } catch (error) {
    logger.error("[Influencer API] deliver failed:", error);
    return failureResponse(c, error);
  }
});
export default app;
