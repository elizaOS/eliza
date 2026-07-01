/**
 * Public app charge request details.
 */

import { Hono } from "hono";
import { appsRepository } from "@/db/repositories/apps";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { appChargeRequestsService } from "@/lib/services/app-charge-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const appId = c.req.param("id");
    const chargeId = c.req.param("chargeId");
    if (!appId || !chargeId) {
      return c.json({ success: false, error: "Missing route parameters" }, 400);
    }

    const [targetApp, charge] = await Promise.all([
      appsRepository.findPublicInfoById(appId),
      appChargeRequestsService.getForApp(appId, chargeId),
    ]);

    if (!targetApp || !charge) {
      return c.json({ success: false, error: "Charge request not found" }, 404);
    }

    // Payer-facing PUBLIC projection. This route is on the unauthenticated
    // allowlist, so we must NOT return the raw `charge` — its `metadata` carries
    // internal data (creator org/user UUIDs, the creator's callback_url, and the
    // agent/room/channel routing ids), and `payerUserId`/`payerOrganizationId`/
    // `providerPaymentId` are internal identifiers. Whitelist only what a payment
    // page needs. The full charge (incl. metadata) stays on the org-scoped
    // authenticated `GET /charges` list.
    const publicCharge = {
      id: charge.id,
      appId: charge.appId,
      amountUsd: charge.amountUsd,
      description: charge.description,
      providers: charge.providers,
      paymentContext: charge.paymentContext,
      paymentUrl: charge.paymentUrl,
      status: charge.status,
      paidAt: charge.paidAt,
      paidProvider: charge.paidProvider,
      expiresAt: charge.expiresAt,
      createdAt: charge.createdAt,
      successUrl: charge.successUrl,
      cancelUrl: charge.cancelUrl,
    };

    return c.json({
      success: true,
      charge: publicCharge,
      app: {
        id: targetApp.id,
        name: targetApp.name,
        description: targetApp.description,
        logo_url: targetApp.logo_url,
        website_url: targetApp.website_url,
      },
    });
  } catch (error) {
    logger.error("[AppCharges API] Failed to get charge request", { error });
    return failureResponse(c, error);
  }
});

export default app;
