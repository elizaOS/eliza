/**
 * Public metadata for the server-registered first-party native OAuth client.
 * The internal app UUID never crosses into the shipped mobile configuration.
 */
import { Hono } from "hono";
import {
  MobileAppAuthProtocolError,
  validateMobileAppAuthClientBinding,
} from "@/lib/services/mobile-app-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  MOBILE_APP_AUTH_CONFIG_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthClientBindingSchema } from "../_schemas";

const app = new Hono<AppEnv>();
app.use(
  "*",
  mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_CONFIG_RATE_LIMIT),
);

app.get("/", async (c) => {
  try {
    const parsed = mobileAppAuthClientBindingSchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid mobile authorization metadata request",
      );
    }
    const { app: appRecord, registration } =
      await requireRegisteredMobileApp(c);
    validateMobileAppAuthClientBinding(registration, parsed.data);
    return c.json({
      success: true,
      clientId: registration.clientId,
      environment: registration.environment,
      redirectUri: registration.redirectUri,
      codeChallengeMethod: "S256",
      scopes: [...registration.scopes],
      app: {
        name: appRecord.name,
        description: appRecord.description,
        logoUrl: appRecord.logo_url,
        websiteUrl: appRecord.website_url,
      },
    });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns the stable mobile protocol error contract.
    return mobileAppAuthErrorResponse(c, error, "config");
  }
});

export default app;
