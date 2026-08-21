/** Exchanges a bound mobile authorization code for an inactive credential. */
import { Hono } from "hono";
import {
  exchangeMobileAppAuthCode,
  MobileAppAuthProtocolError,
} from "@/lib/services/mobile-app-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthTokenSchema } from "../_schemas";

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
      // error-policy:J3 Invalid JSON is an explicit caller error, not a dependency outage.
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid mobile authorization token request",
      );
    }
    const parsed = mobileAppAuthTokenSchema.safeParse(body);
    if (!parsed.success) {
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid mobile authorization token request",
      );
    }
    const { registration } = await requireRegisteredMobileApp(c);
    const result = await exchangeMobileAppAuthCode({
      registration,
      binding: {
        clientId: parsed.data.clientId,
        environment: parsed.data.environment,
        redirectUri: parsed.data.redirectUri,
        state: parsed.data.state,
      },
      code: parsed.data.code,
      codeVerifier: parsed.data.codeVerifier,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns the stable mobile protocol error contract.
    return mobileAppAuthErrorResponse(c, error, "token");
  }
});

export default app;
