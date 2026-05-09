/**
 * Token Redemption API Routes
 *
 * POST /api/v1/redemptions - Create a new redemption request
 * GET /api/v1/redemptions - List user's redemption history
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { payoutStatusService } from "@/lib/services/payout-status";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CreateRedemptionSchema = z.object({
  appId: z.string().uuid().optional(),
  pointsAmount: z
    .number()
    .int()
    .min(100, "Minimum redemption is 100 points ($1.00)")
    .max(100000, "Maximum redemption is 100,000 points ($1,000.00)"),
  network: z.enum(["ethereum", "base", "bnb", "bsc", "solana"]),
  payoutAddress: z.string().min(20).max(100),
  signature: z.string().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

function normalizeRedemptionNetwork(network: z.infer<typeof CreateRedemptionSchema>["network"]) {
  return network === "bsc" ? "bnb" : network;
}

const app = new Hono<AppEnv>();

app.options(
  "/",
  (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.post("/", rateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    if (c.env.REDEMPTION_EMERGENCY_PAUSE === "true") {
      logger.warn("[Redemption API] Emergency pause active - rejecting request");
      return c.json(
        {
          success: false,
          error: "Redemptions are temporarily paused for maintenance. Please try again later.",
          paused: true,
        },
        503,
      );
    }

    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const validation = CreateRedemptionSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: validation.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        },
        400,
      );
    }

    const { appId, pointsAmount, payoutAddress, signature, idempotencyKey } = validation.data;
    const network = normalizeRedemptionNetwork(validation.data.network);

    const networkAvailability = await payoutStatusService.isNetworkAvailable(network);
    if (!networkAvailability.available) {
      const status = await payoutStatusService.getStatus();
      const availableNetworks = status.networks
        .filter((n) => n.status === "operational" || n.status === "low_balance")
        .map((n) => n.network);

      logger.warn("[Redemption API] Network unavailable", {
        network,
        message: networkAvailability.message,
        availableNetworks,
        userId: user.id.slice(0, 8) + "...",
      });

      return c.json(
        {
          success: false,
          error: networkAvailability.message,
          availableNetworks,
          suggestion:
            availableNetworks.length > 0
              ? `Try one of these networks instead: ${availableNetworks.join(", ")}`
              : "Token redemption is temporarily unavailable. Please check back later.",
        },
        503,
      );
    }

    const userAgent = c.req.header("user-agent") ?? undefined;
    const ipAddress =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      undefined;

    const maskedAddress =
      payoutAddress.length > 20
        ? `${payoutAddress.slice(0, 6)}...${payoutAddress.slice(-4)}`
        : "***";

    logger.info("[Redemption API] Creating secure redemption request", {
      userId: user.id.slice(0, 8) + "...",
      appId,
      pointsAmount,
      usdValue: (pointsAmount / 100).toFixed(2),
      network,
      payoutAddress: maskedAddress,
      hasSignature: !!signature,
      hasIdempotencyKey: !!idempotencyKey,
    });

    const result = await secureTokenRedemptionService.createRedemption({
      userId: user.id,
      appId,
      pointsAmount,
      network,
      payoutAddress,
      signature,
      idempotencyKey,
      metadata: {
        userAgent,
        ipAddress,
      },
    });

    if (!result.success) {
      logger.warn("[Redemption API] Secure redemption request failed", {
        userId: user.id.slice(0, 8) + "...",
        error: result.error,
      });

      return c.json({ success: false, error: result.error }, 400);
    }

    logger.info("[Redemption API] Secure redemption request created", {
      redemptionId: result.redemptionId,
      userId: user.id.slice(0, 8) + "...",
      usdValue: result.quote?.usdValue,
      elizaAmount: result.quote?.elizaAmount,
      requiresReview: result.quote?.requiresReview,
    });

    return c.json({
      success: true,
      redemptionId: result.redemptionId,
      quote: result.quote,
      warnings: result.warnings,
      message: result.quote?.requiresReview
        ? "Redemption created. An admin will review the payout request before tokens are sent."
        : "Redemption created and will be processed shortly.",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;

    const redemptions = await secureTokenRedemptionService.listUserRedemptions(user.id, limit);

    return c.json({
      success: true,
      redemptions: redemptions.map((r) => ({
        id: r.id,
        pointsAmount: Number(r.points_amount),
        usdValue: Number(r.usd_value),
        elizaAmount: Number(r.eliza_amount),
        elizaPriceUsd: Number(r.eliza_price_usd),
        network: r.network,
        payoutAddress: `${r.payout_address.slice(0, 6)}...${r.payout_address.slice(-4)}`,
        status: r.status,
        txHash: r.tx_hash,
        createdAt: r.created_at.toISOString(),
        completedAt: r.completed_at?.toISOString(),
        failureReason: r.failure_reason,
        requiresReview: r.requires_review,
      })),
      paused: c.env.REDEMPTION_EMERGENCY_PAUSE === "true",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
