/**
 * GET /api/v1/subscription/entitlement
 * Returns `{ entitlement: <compact ES256 JWS> }`: the caller's current plan
 * state for native clients. Auth: Cloud CLI API key
 * (`Authorization: Bearer eliza_…`) or a browser session. The token (format v2)
 * carries the current allowance period in micro-dollars when there is one. It presents
 * plan state only; Cloud still authorizes every inference request itself.
 * Fails closed with 503 while the signing key or issuer is not configured.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  type EntitlementPlanSummary,
  EntitlementSigningUnavailableError,
  readOrganizationEntitlementSummary,
  type SignEntitlementInput,
  signSubscriptionEntitlement,
} from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface SubscriptionEntitlementRouteDependencies {
  authenticate(c: AppContext): Promise<{ id: string; organization_id: string }>;
  summary(organizationId: string): Promise<EntitlementPlanSummary>;
  sign(input: SignEntitlementInput): Promise<string>;
}

const defaultDependencies: SubscriptionEntitlementRouteDependencies = {
  authenticate: requireUserOrApiKeyWithOrg,
  summary: (organizationId) =>
    readOrganizationEntitlementSummary(organizationId, { allowance: true }),
  sign: (input) => signSubscriptionEntitlement(input),
};

function unavailable(c: AppContext) {
  return c.json(
    {
      success: false,
      error: "Subscription entitlement is temporarily unavailable",
      code: "service_unavailable",
    },
    503,
    { ...NO_STORE, "Retry-After": "60" },
  );
}

export function createSubscriptionEntitlementRoute(
  dependencies: SubscriptionEntitlementRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimit(RateLimitPresets.STANDARD));

  app.get("/", async (c) => {
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
    try {
      const summary = await dependencies.summary(user.organization_id);
      const entitlement = await dependencies.sign({
        userId: user.id,
        organizationId: user.organization_id,
        summary,
      });
      return c.json({ entitlement }, 200, NO_STORE);
    } catch (error) {
      if (error instanceof EntitlementSigningUnavailableError) {
        logger.error("[SubscriptionEntitlement] Signing is not configured", {
          error: error.message,
        });
        return unavailable(c);
      }
      // error-policy:J1 a policy or database failure is a billing outage for the
      // client, which keeps Cloud as the per-request authority.
      logger.error("[SubscriptionEntitlement] Entitlement unavailable", {
        organizationId: user.organization_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable(c);
    }
  });

  return app;
}

export default createSubscriptionEntitlementRoute();
