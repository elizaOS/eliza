/**
 * GET /api/v1/subscription/entitlement-keys (public)
 * Returns `{ keys: [P-256 public JWK] }` for verifying subscription
 * entitlements: the current signing key and, during rotation, the previous
 * key and a next key published before it signs. Never private material.
 * Fails closed with 503 while unconfigured.
 */

import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  ENTITLEMENT_KEYS_MAX_AGE_SECONDS,
  EntitlementSigningUnavailableError,
  publishedEntitlementKeys,
} from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import type { JWK } from "jose";

export interface SubscriptionEntitlementKeysRouteDependencies {
  keys(): Promise<{ keys: JWK[] }>;
}

export function createSubscriptionEntitlementKeysRoute(
  dependencies: SubscriptionEntitlementKeysRouteDependencies = {
    keys: () => publishedEntitlementKeys(),
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", rateLimit(RateLimitPresets.AGGRESSIVE), async (c) => {
    try {
      const { keys } = await dependencies.keys();
      return c.json({ keys }, 200, {
        "Cache-Control": `public, max-age=${ENTITLEMENT_KEYS_MAX_AGE_SECONDS}`,
      });
    } catch (error) {
      if (!(error instanceof EntitlementSigningUnavailableError)) throw error;
      logger.error(
        "[SubscriptionEntitlementKeys] Signing keys are not configured",
        {
          error: error.message,
        },
      );
      return c.json(
        {
          success: false,
          error: "Entitlement keys are not configured",
          code: "service_unavailable",
        },
        503,
        { "Cache-Control": "no-store", "Retry-After": "60" },
      );
    }
  });
  return app;
}

export default createSubscriptionEntitlementKeysRoute();
