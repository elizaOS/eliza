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
import {
  moneyRateLimit,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { payoutStatusService } from "@/lib/services/payout-status";
import { normalizeRedemptionClientIp } from "@/lib/services/redemption-client-ip";
import {
  REDEMPTION_ORIGIN_VERIFICATION_ERROR,
  type SecureRedemptionResult,
  secureTokenRedemptionService,
} from "@/lib/services/token-redemption-secure";
import { parseClampedLimit } from "@/lib/utils/clamp-limit";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  type CreateRedemptionSuccessResponse,
  canonicalizeRedemptionNetwork,
  type ExplicitCreateRedemptionRequest,
  type ListRedemptionsResponse,
  REDEMPTION_MAX_POINTS,
  REDEMPTION_MIN_POINTS,
  REDEMPTION_NETWORKS,
} from "@/types/redemption-contract";
import { usdFromPoints } from "@/lib/services/earnings-units";

const CreateRedemptionSchema = z.object({
  appId: z.string().uuid().optional(),
  pointsAmount: z
    .number()
    .int()
    .min(REDEMPTION_MIN_POINTS, "Minimum redemption is 100 points ($1.00)")
    .max(
      REDEMPTION_MAX_POINTS,
      "Maximum redemption is 100,000 points ($1,000.00)",
    ),
  network: z.enum(REDEMPTION_NETWORKS),
  // Preserve the historical raw-wire USDC default (#10732). Quote-coupled
  // clients send the quote's explicit asset and never rely on this fallback.
  asset: z.enum(["eliza", "usdc"]).optional().default("usdc"),
  payoutAddress: z.string().min(20).max(100),
  signature: z.string().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

export function resolveRedemptionClientIp(
  headers: Headers,
): string | undefined {
  return normalizeRedemptionClientIp(headers.get("cf-connecting-ip"));
}

function serializeSuccessfulRedemption(
  result: SecureRedemptionResult,
): CreateRedemptionSuccessResponse {
  if (!result.success || !result.redemptionId) {
    throw new Error(
      "Redemption service returned success without a redemption receipt",
    );
  }

  return {
    success: true,
    redemptionId: result.redemptionId,
    quote: result.quote
      ? {
          ...result.quote,
          expiresAt: result.quote.expiresAt.toISOString(),
        }
      : undefined,
    warnings: result.warnings,
    message: result.quote?.requiresReview
      ? "Redemption created. An admin will review the payout request before tokens are sent."
      : "Redemption created and will be processed shortly.",
  };
}

const app = new Hono<AppEnv>();

app.options(
  "/",
  (_c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
  let replayCurrentIntent:
    | (() => Promise<SecureRedemptionResult | null>)
    | undefined;
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;

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

    const {
      appId,
      pointsAmount,
      payoutAddress,
      signature,
      idempotencyKey,
      asset,
    } = validation.data satisfies ExplicitCreateRedemptionRequest;
    const network = canonicalizeRedemptionNetwork(validation.data.network);
    replayCurrentIntent = () =>
      idempotencyKey
        ? secureTokenRedemptionService.replayRedemption({
            userId: user.id,
            appId,
            pointsAmount,
            network,
            asset,
            payoutAddress,
            idempotencyKey,
          })
        : Promise.resolve(null);
    const respondToReplay = (replay: SecureRedemptionResult) => {
      if (!replay.success) {
        return c.json({ success: false, error: replay.error }, 400);
      }

      logger.info("[Redemption API] Replayed secure redemption receipt", {
        redemptionId: replay.redemptionId,
        userId: `${user.id.slice(0, 8)}...`,
      });
      return c.json(serializeSuccessfulRedemption(replay));
    };

    // Recover a durable receipt before mutable availability/origin gates. This
    // lets a client whose first response was lost retry the exact request even
    // if the system was paused, the hot wallet changed state, or the original
    // trusted IP is no longer available. Authentication and schema validation
    // still happen first, and user/key/intent matching is enforced by service.
    const replay = await replayCurrentIntent();
    if (replay) return respondToReplay(replay);

    if (c.env.REDEMPTION_EMERGENCY_PAUSE === "true") {
      const concurrentReplay = await replayCurrentIntent();
      if (concurrentReplay) return respondToReplay(concurrentReplay);
      logger.warn(
        "[Redemption API] Emergency pause active - rejecting request",
      );
      return c.json(
        {
          success: false,
          error:
            "Redemptions are temporarily paused for maintenance. Please try again later.",
          paused: true,
        },
        503,
      );
    }

    // The network-availability probe reflects the elizaOS hot-wallet status and
    // only applies to elizaOS payouts. USDC payouts (#10732) are guarded by the
    // payout processor's own USDC balance check before broadcast.
    const networkAvailability =
      asset === "usdc"
        ? { available: true, message: "" }
        : await payoutStatusService.isNetworkAvailable(network);
    if (!networkAvailability.available) {
      const concurrentReplay = await replayCurrentIntent();
      if (concurrentReplay) return respondToReplay(concurrentReplay);
      const status = await payoutStatusService.getStatus();
      const availableNetworks = status.networks
        .filter((n) => n.status === "operational" || n.status === "low_balance")
        .map((n) => n.network);

      logger.warn("[Redemption API] Network unavailable", {
        network,
        message: networkAvailability.message,
        availableNetworks,
        userId: `${user.id.slice(0, 8)}...`,
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
    const ipAddress = resolveRedemptionClientIp(c.req.raw.headers);
    if (!ipAddress) {
      const concurrentReplay = await replayCurrentIntent();
      if (concurrentReplay) return respondToReplay(concurrentReplay);
      logger.warn("[Redemption API] Missing trusted client IP", {
        userId: `${user.id.slice(0, 8)}...`,
      });
      return c.json(
        { success: false, error: REDEMPTION_ORIGIN_VERIFICATION_ERROR },
        400,
      );
    }

    const maskedAddress =
      payoutAddress.length > 20
        ? `${payoutAddress.slice(0, 6)}...${payoutAddress.slice(-4)}`
        : "***";

    logger.info("[Redemption API] Creating secure redemption request", {
      userId: `${user.id.slice(0, 8)}...`,
      appId,
      pointsAmount,
      usdValue: usdFromPoints(pointsAmount).toFixed(2),
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
      asset,
      payoutAddress,
      signature,
      idempotencyKey,
      metadata: {
        userAgent,
        ipAddress,
      },
    });

    if (!result.success) {
      // A concurrent request can commit while this request is evaluating an
      // external address/oracle/wallet gate. Prefer the durable writer receipt
      // before exposing a transient failure for the same exact intent.
      const concurrentReplay = await replayCurrentIntent();
      if (concurrentReplay) return respondToReplay(concurrentReplay);

      logger.warn("[Redemption API] Secure redemption request failed", {
        userId: `${user.id.slice(0, 8)}...`,
        error: result.error,
      });

      return c.json({ success: false, error: result.error }, 400);
    }

    logger.info("[Redemption API] Secure redemption request created", {
      redemptionId: result.redemptionId,
      userId: `${user.id.slice(0, 8)}...`,
      usdValue: result.quote?.usdValue,
      elizaAmount: result.quote?.elizaAmount,
      requiresReview: result.quote?.requiresReview,
    });

    return c.json(serializeSuccessfulRedemption(result));
  } catch (error) {
    // A thrown provider/DB read can race with the other exact request reaching
    // a durable commit. Make one final writer read before exposing a 500.
    if (replayCurrentIntent) {
      try {
        const concurrentReplay = await replayCurrentIntent();
        if (concurrentReplay) {
          if (!concurrentReplay.success) {
            return c.json(
              { success: false, error: concurrentReplay.error },
              400,
            );
          }
          return c.json(serializeSuccessfulRedemption(concurrentReplay));
        }
      } catch (replayError) {
        logger.error("[Redemption API] Final receipt replay threw", {
          error:
            replayError instanceof Error
              ? replayError.message
              : String(replayError),
        });
      }
    }

    // failureResponse maps unknown throws to a generic 500 and does NOT log; a
    // thrown TWAP-oracle / payout-status / token-availability failure would
    // otherwise leave no trace. Log it so payout failures are diagnosable.
    logger.error("[Redemption API] Redemption request threw", {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return failureResponse(c, error);
  }
});

app.get("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const limitParam = c.req.query("limit");
    const limit = parseClampedLimit(limitParam, 20);

    const redemptions = await secureTokenRedemptionService.listUserRedemptions(
      user.id,
      limit,
    );

    const response = {
      success: true,
      redemptions: redemptions.map((r) => ({
        id: r.id,
        pointsAmount: Number(r.points_amount),
        usdValue: Number(r.usd_value),
        elizaAmount: Number(r.eliza_amount),
        elizaPriceUsd: Number(r.eliza_price_usd),
        asset: r.asset,
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
    } satisfies ListRedemptionsResponse;

    return c.json(response);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
