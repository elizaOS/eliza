/**
 * POST /api/v1/subscription/redeem
 * Redeems a Cloud subscription grant code (for example the Alpha Phone
 * six-month Plus grant) for the caller's organization.
 *
 * Auth: the phone's Cloud CLI API key (`Authorization: Bearer eliza_…`) or a
 * browser session. Body: `{ code, idempotencyKey }`. Unknown, expired,
 * disabled and fully redeemed codes share one generic 400 answer; a replay of
 * the same code for the same organization returns the original grant.
 * Limits: per credential and per IP, in counters of their own (never shared
 * with other routes), bounded locally if Redis is unavailable. Codes are
 * 16 Crockford base32 characters (80 bits), so the limits are defense in depth.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  hashSubscriptionGrantCode,
  normalizeSubscriptionGrantCode,
  type RedeemSubscriptionGrantInput,
  type RedeemSubscriptionGrantResult,
  SUBSCRIPTION_GRANT_ALREADY_GRANTED,
  SUBSCRIPTION_GRANT_CODE_INVALID,
  SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT,
  SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
  subscriptionGrantsRepository,
} from "@elizaos/cloud-shared/db/repositories/subscription-grants";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  getDefaultKey,
  getIpKey,
  type RateLimitDependencies,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { getCloudAwareEnv } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  type EntitlementPlanSummary,
  readOrganizationEntitlementSummary,
} from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const WINDOW_MS = 15 * 60_000;
/** A device redeems once; retries replay. These bound guessing, not normal use. */
export const REDEEM_LIMIT_PER_CREDENTIAL = 5;
/** Many phones can share one carrier-grade NAT address on activation day. */
export const REDEEM_LIMIT_PER_IP = 60;

const bodySchema = z
  .object({
    code: z.string().min(1).max(128),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();

const INVALID_CODE_BODY = {
  success: false as const,
  error: "This subscription code cannot be redeemed.",
  code: "invalid_subscription_code" as const,
};

export interface SubscriptionRedeemRouteDependencies {
  authenticate(c: AppContext): Promise<{ id: string; organization_id: string }>;
  pepper(): string | undefined;
  redeem(
    input: RedeemSubscriptionGrantInput,
  ): Promise<RedeemSubscriptionGrantResult>;
  summary(organizationId: string): Promise<EntitlementPlanSummary>;
  /** Test hook: the Redis client the limiters use. */
  rateLimit?: RateLimitDependencies;
}

const defaultDependencies: SubscriptionRedeemRouteDependencies = {
  authenticate: requireUserOrApiKeyWithOrg,
  pepper: () =>
    getCloudAwareEnv().ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER || undefined,
  redeem: (input) => subscriptionGrantsRepository.redeem(input),
  summary: readOrganizationEntitlementSummary,
};

export function createSubscriptionRedeemRoute(
  dependencies: SubscriptionRedeemRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    rateLimit(
      {
        windowMs: WINDOW_MS,
        maxRequests: REDEEM_LIMIT_PER_IP,
        keyGenerator: (c) => `subscription-redeem:${getIpKey(c)}`,
        localLease: false,
        redisUnavailableFallback: { namespace: "subscription-redeem-ip" },
      },
      undefined,
      dependencies.rateLimit,
    ),
  );
  app.use(
    "*",
    rateLimit(
      {
        windowMs: WINDOW_MS,
        maxRequests: REDEEM_LIMIT_PER_CREDENTIAL,
        // Own counter: the default key is shared by every STANDARD route.
        keyGenerator: (c) => `subscription-redeem:${getDefaultKey(c)}`,
        localLease: false,
        redisUnavailableFallback: {
          namespace: "subscription-redeem-credential",
        },
      },
      undefined,
      dependencies.rateLimit,
    ),
  );

  app.post("/", async (c) => {
    let user: { id: string; organization_id: string };
    try {
      user = await dependencies.authenticate(c);
    } catch (error) {
      if (error instanceof ApiError)
        return c.json(
          { success: false, error: error.message, code: error.code },
          error.status,
          NO_STORE,
        );
      throw error;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: "Invalid JSON in request body",
          code: "validation_error",
        },
        400,
        NO_STORE,
      );
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: "code and idempotencyKey are required",
          code: "validation_error",
        },
        400,
        NO_STORE,
      );

    const pepper = dependencies.pepper();
    if (!pepper) {
      logger.error(
        "[SubscriptionRedeem] ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER is not configured",
      );
      return c.json(
        {
          success: false,
          error: "Subscription codes are temporarily unavailable",
          code: "service_unavailable",
        },
        503,
        { ...NO_STORE, "Retry-After": "60" },
      );
    }
    const normalized = normalizeSubscriptionGrantCode(parsed.data.code);
    // Hash malformed input too, so well-formed and malformed guesses cost the same.
    const codeHash = await hashSubscriptionGrantCode(
      normalized ?? parsed.data.code,
      pepper,
    );
    if (!normalized) return c.json(INVALID_CODE_BODY, 400, NO_STORE);

    try {
      const result = await dependencies.redeem({
        organizationId: user.organization_id,
        userId: user.id,
        codeHash,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      // The grant is committed. A failed summary read must not report the
      // redemption as failed; the client can read the entitlement route.
      let summary: EntitlementPlanSummary | null = null;
      try {
        summary = await dependencies.summary(user.organization_id);
      } catch (error) {
        logger.warn("[SubscriptionRedeem] Entitlement summary read failed", {
          organizationId: user.organization_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return c.json(
        {
          success: true as const,
          replayed: result.replayed,
          grant: {
            id: result.grant.id,
            planKey: result.grant.plan_key,
            startsAt: result.grant.starts_at.toISOString(),
            endsAt: result.grant.ends_at?.toISOString() ?? null,
            revoked: result.grant.revoked_at !== null,
            // An effective paid plan keeps precedence; the grant serves only
            // inside its window after the paid plan stops serving.
            paidPlanTakesPrecedence: summary?.source === "subscription",
          },
          entitlement: summary && {
            plan: summary.plan,
            source: summary.source,
            effectiveUntil: summary.effectiveUntil?.toISOString() ?? null,
          },
        },
        200,
        NO_STORE,
      );
    } catch (error) {
      if (error instanceof ElizaError) {
        if (error.code === SUBSCRIPTION_GRANT_CODE_INVALID)
          return c.json(INVALID_CODE_BODY, 400, NO_STORE);
        if (error.code === SUBSCRIPTION_GRANT_ALREADY_GRANTED)
          return c.json(
            {
              success: false,
              error:
                "This account has already received this subscription grant.",
              code: "subscription_grant_already_redeemed",
            },
            409,
            NO_STORE,
          );
        if (error.code === SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE)
          return c.json(
            {
              success: false,
              error:
                "This account already has a paid plan. This subscription code cannot be added to it.",
              code: "subscription_grant_paid_plan_active",
            },
            409,
            NO_STORE,
          );
        if (error.code === SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT)
          return c.json(
            {
              success: false,
              error: "idempotencyKey was already used for a different code.",
              code: "idempotency_conflict",
            },
            409,
            NO_STORE,
          );
        if (error.code === "SUBSCRIPTION_GRANT_ORGANIZATION_UNAVAILABLE")
          return c.json(
            {
              success: false,
              error: "Organization is not active",
              code: "access_denied",
            },
            403,
            NO_STORE,
          );
      }
      logger.error("[SubscriptionRedeem] Redemption failed", {
        organizationId: user.organization_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          success: false,
          error: "Failed to redeem code",
          code: "internal_error",
        },
        500,
        NO_STORE,
      );
    }
  });

  return app;
}

export default createSubscriptionRedeemRoute();
