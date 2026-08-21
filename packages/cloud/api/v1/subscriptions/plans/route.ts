/**
 * Publishes the server-owned recurring plan catalog only after its Stripe
 * objects pass the exact read-only provider preflight.
 */

import { Hono } from "hono";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
} from "@/lib/services/subscription-catalog";
import { requireStripe } from "@/lib/stripe";
import type { SubscriptionPlansDto } from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

// Provider/configuration verification is part of publication. A shared edge
// cache would bypass that fail-closed boundary after a binding rotation or
// deploy, so clients must re-enter the Worker for every catalog read.
const SUCCESS_CACHE_CONTROL = "no-store";
const FAILURE_RETRY_SECONDS = "60";

interface SubscriptionPlansRouteDependencies {
  loadPlans(): Promise<SubscriptionPlansDto>;
}

const defaultDependencies: SubscriptionPlansRouteDependencies = {
  async loadPlans() {
    return await getVerifiedSubscriptionPlans({
      env: getCloudAwareEnv(),
      provider: adaptStripeSubscriptionCatalogProvider(requireStripe()),
    });
  },
};

export function createSubscriptionPlansRoute(
  dependencies: SubscriptionPlansRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    try {
      const plans = await dependencies.loadPlans();
      c.header("Cache-Control", SUCCESS_CACHE_CONTROL);
      return c.json({ success: true as const, data: plans });
    } catch (error) {
      // error-policy:J1 The public transport boundary emits one explicit,
      // retryable unavailable state and never exposes provider identifiers.
      logger.error("[SubscriptionPlansAPI] Catalog unavailable", {
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "SUBSCRIPTION_CATALOG_UNAVAILABLE",
      });
      c.header("Cache-Control", "no-store");
      c.header("Retry-After", FAILURE_RETRY_SECONDS);
      return c.json(
        {
          success: false as const,
          error: "Subscription plans are temporarily unavailable",
          code: "service_unavailable" as const,
        },
        503,
      );
    }
  });

  return app;
}

export default createSubscriptionPlansRoute();
