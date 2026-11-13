/**
 * Reconciles the caller's checkout return using provider payment evidence, never redirect
 * parameters as payment authority.
 *
 * Auth: an owner/admin browser session, or that owner/admin's acknowledged first-party mobile
 * credential (`Authorization: Bearer eliza_mobile_…`), so a native app can settle its own
 * purchase when it returns from the hosted page, while that credential's native client is still
 * registered and enabled. The session must belong to the caller's
 * organization. The answer carries the organization's entitlement as Cloud now serves it.
 */

import { requireCurrentBillingManager } from "@elizaos/cloud-shared/auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { resolveMobileCredentialRegistration } from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import { reconcileSubscriptionCheckout } from "@elizaos/cloud-shared/lib/services/subscription-checkout";
import {
  type EntitlementPlanSummary,
  readOrganizationEntitlementSummary,
} from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { checkoutFailure, checkoutFailureDiagnostic } from "../_boundary";

const schema = z
  .object({ sessionId: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/) })
  .strict();

export interface SubscriptionCheckoutConfirmRouteDependencies {
  authorize: typeof requireCurrentBillingManager;
  resolveRegistration: typeof resolveMobileCredentialRegistration;
  reconcile: typeof reconcileSubscriptionCheckout;
  summary(organizationId: string): Promise<EntitlementPlanSummary>;
}

const defaultDependencies: SubscriptionCheckoutConfirmRouteDependencies = {
  authorize: requireCurrentBillingManager,
  resolveRegistration: resolveMobileCredentialRegistration,
  reconcile: reconcileSubscriptionCheckout,
  summary: (organizationId) =>
    readOrganizationEntitlementSummary(organizationId),
};

export function createSubscriptionCheckoutConfirmRoute(
  dependencies: SubscriptionCheckoutConfirmRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
    c.header("Cache-Control", "no-store");
    let phase = "authorization";
    try {
      const { user, mobileCredential } = await dependencies.authorize(c);
      // A mobile credential acts only while its native client is still the
      // registered, enabled client it was issued under.
      if (mobileCredential)
        await dependencies.resolveRegistration(c.env, mobileCredential);
      phase = "request_validation";
      const decoded = await decodeRequestJson(c.req);
      if (!decoded.ok)
        return c.json(
          {
            success: false,
            error: "Invalid JSON body",
            code: "validation_error",
          },
          400,
        );
      const { sessionId } = schema.parse(decoded.value);
      phase = "reconciliation";
      const data = await dependencies.reconcile(
        sessionId,
        user.organization_id,
      );
      phase = "response";
      // The subscription is committed. A failed summary read must not report the
      // purchase as failed; the client can read the entitlement route.
      let summary: EntitlementPlanSummary | null = null;
      try {
        summary = await dependencies.summary(user.organization_id);
      } catch (error) {
        logger.warn(
          "[SubscriptionCheckoutConfirm] Entitlement summary read failed",
          {
            organizationId: user.organization_id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return c.json({
        success: true as const,
        data,
        entitlement: summary && {
          plan: summary.plan,
          source: summary.source,
          effectiveUntil: summary.effectiveUntil?.toISOString() ?? null,
        },
      });
    } catch (error) {
      // error-policy:J1 Return sanitized failures without exposing provider objects.
      const response = checkoutFailure(c, error);
      if (response.status >= 500) {
        logger.error("[SubscriptionCheckoutConfirm] Failed", {
          phase,
          ...checkoutFailureDiagnostic(error),
        });
      }
      return response;
    }
  });
  return app;
}

export default createSubscriptionCheckoutConfirmRoute();
