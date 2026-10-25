/**
 * Resolves a signed, expiring Dedicated-fallback recovery link (#25146).
 *
 * Public by path: the token is the credential. A verified link redirects to
 * `/cloud/billing` with the organization context and nothing else; the billing
 * page still requires the signed-in owner, and payment is confirmed only by the
 * billing lifecycle. Invalid and expired links are typed refusals.
 */

import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  PersonalFallbackRecoveryLinkError,
  resolvePersonalFallbackRecoveryLink,
} from "@elizaos/cloud-shared/lib/services/personal-fallback-recovery-link";
import { getAppUrl } from "@elizaos/cloud-shared/lib/utils/app-url";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const { billingUrl } = await resolvePersonalFallbackRecoveryLink(
      c.req.param("token") ?? "",
      { appUrl: getAppUrl(c.env) },
    );
    return c.redirect(billingUrl, 302);
  } catch (error) {
    if (error instanceof PersonalFallbackRecoveryLinkError) {
      if (error.code === "PERSONAL_FALLBACK_RECOVERY_LINK_UNCONFIGURED") {
        return c.json(
          {
            success: false,
            code: "recovery_link_unavailable",
            error:
              "Recovery links are unavailable. Open billing from your account.",
            billingPath: "/cloud/billing",
          },
          503,
        );
      }
      const expired = error.code === "PERSONAL_FALLBACK_RECOVERY_LINK_EXPIRED";
      return c.json(
        {
          success: false,
          code: expired ? "recovery_link_expired" : "invalid_recovery_link",
          error: expired
            ? "This recovery link has expired. Open billing from your account."
            : "This recovery link is invalid.",
          billingPath: "/cloud/billing",
        },
        expired ? 410 : 400,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
