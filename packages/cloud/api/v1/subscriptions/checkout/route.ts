/**
 * Starts a recurring checkout for a freshly authorized organization billing manager.
 *
 * Auth: an owner/admin browser session, or that owner/admin's acknowledged first-party
 * mobile credential (`Authorization: Bearer eliza_mobile_…`). A mobile credential may only
 * request `presentation: "mobile"`, and only a mobile credential may: its success and cancel
 * returns are derived from the credential's registered native client, never from the request.
 */

import { requireCurrentBillingManager } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  ForbiddenError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  mobileBillingReturnUrl,
  resolveMobileCredentialRegistration,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import { submitSubscriptionCheckout } from "@elizaos/cloud-shared/lib/services/subscription-checkout";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { checkoutFailure } from "./_boundary";

const schema = z
  .object({
    planKey: z.enum(["plus_monthly", "pro_monthly"]),
    idempotencyKey: z.string().uuid(),
    /**
     * hosted (default) redirects this browser; embedded mounts an in-app form; shared is a
     * link for another payer; mobile is a hosted page that returns to the calling native app.
     */
    presentation: z.enum(["hosted", "embedded", "shared", "mobile"]).optional(),
  })
  .strict();

export interface SubscriptionCheckoutRouteDependencies {
  authorize: typeof requireCurrentBillingManager;
  resolveRegistration: typeof resolveMobileCredentialRegistration;
  submit: typeof submitSubscriptionCheckout;
}

const defaultDependencies: SubscriptionCheckoutRouteDependencies = {
  authorize: requireCurrentBillingManager,
  resolveRegistration: resolveMobileCredentialRegistration,
  submit: submitSubscriptionCheckout,
};

export function createSubscriptionCheckoutRoute(
  dependencies: SubscriptionCheckoutRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const { user, mobileCredential } = await dependencies.authorize(c);
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
      const input = schema.parse(decoded.value);
      if ((input.presentation === "mobile") !== (mobileCredential !== null))
        throw new ApiError(
          400,
          "validation_error",
          mobileCredential
            ? 'A mobile credential must request presentation "mobile".'
            : 'presentation "mobile" requires the app\'s own mobile credential.',
        );
      // Read again before every provider write: a client disabled or re-pointed
      // after this request started must not receive a checkout.
      const resolveMobileReturn = async (
        credential: typeof mobileCredential,
      ): Promise<string | undefined> =>
        credential
          ? mobileBillingReturnUrl(
              (await dependencies.resolveRegistration(c.env, credential))
                .redirectUri,
            )
          : undefined;
      const mobileReturnUrl = await resolveMobileReturn(mobileCredential);
      const data = await dependencies.submit(
        {
          ...input,
          organizationId: user.organization_id,
          actorId: user.id,
          ...(mobileReturnUrl ? { mobileReturnUrl } : {}),
        },
        async () => {
          const current = await dependencies.authorize(c);
          if (
            current.user.id !== user.id ||
            current.user.organization_id !== user.organization_id ||
            (current.mobileCredential?.id ?? null) !==
              (mobileCredential?.id ?? null) ||
            (await resolveMobileReturn(current.mobileCredential)) !==
              mobileReturnUrl
          )
            throw ForbiddenError("Organization billing authority changed");
        },
      );
      return c.json({ success: true as const, data });
    } catch (error) {
      // error-policy:J1 Sanitize provider and authority failures at the HTTP boundary.
      return checkoutFailure(c, error);
    }
  });
  return app;
}

export default createSubscriptionCheckoutRoute();
