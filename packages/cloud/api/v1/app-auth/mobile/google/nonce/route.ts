/**
 * Issues the one-time server challenge that Android Credential Manager embeds
 * in Google's ID token. The challenge is bound to the exact validated mobile
 * PKCE request before any external identity UI opens.
 */

import { Hono } from "hono";
import {
  MobileAppAuthProtocolError,
  validateMobileAppAuthPkceBinding,
} from "@/lib/services/mobile-app-auth";
import {
  issueMobileGoogleAuthNonce,
  resolveMobileGoogleAuthReadiness,
} from "@/lib/services/mobile-google-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
} from "../../_rate-limit";
import { requireRegisteredMobileApp } from "../../_registration";
import { mobileAppAuthErrorResponse } from "../../_response";
import { mobileAppAuthGoogleNonceSchema } from "../../_schemas";

const app = new Hono<AppEnv>();
app.use(
  "*",
  mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_TOKEN_RATE_LIMIT),
);

app.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J3 malformed native payload is explicit invalid input.
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid Google sign-in challenge request",
      );
    }
    const parsed = mobileAppAuthGoogleNonceSchema.safeParse(body);
    if (!parsed.success) {
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid Google sign-in challenge request",
      );
    }
    const { registration } = await requireRegisteredMobileApp(c);
    validateMobileAppAuthPkceBinding(registration, parsed.data);
    if (!resolveMobileGoogleAuthReadiness(c.env)) {
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Native Google sign-in is not configured",
      );
    }
    const challenge = await issueMobileGoogleAuthNonce(c.env, parsed.data);
    return c.json({ success: true, ...challenge });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns the stable mobile protocol error contract.
    return mobileAppAuthErrorResponse(c, error, "google_nonce");
  }
});

export default app;
