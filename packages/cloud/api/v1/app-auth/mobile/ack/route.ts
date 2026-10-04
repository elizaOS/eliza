/** Activates a mobile credential only after the client proves durable receipt. */

import {
  acknowledgeMobileAppAuthCredential,
  MobileAppAuthProtocolError,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  MOBILE_APP_AUTH_ACK_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthAckSchema } from "../_schemas";

const app = new Hono<AppEnv>();
app.use("*", mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_ACK_RATE_LIMIT));

app.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J3 Invalid JSON is an explicit caller error, not a dependency outage.
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid mobile credential acknowledgement",
      );
    }
    const parsed = mobileAppAuthAckSchema.safeParse(body);
    if (!parsed.success) {
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid mobile credential acknowledgement",
      );
    }
    const { registration } = await requireRegisteredMobileApp(
      c,
      parsed.data.clientId,
    );
    const result = await acknowledgeMobileAppAuthCredential({
      registration,
      binding: {
        clientId: parsed.data.clientId,
        environment: parsed.data.environment,
        redirectUri: parsed.data.redirectUri,
        state: parsed.data.state,
      },
      code: parsed.data.code,
      codeVerifier: parsed.data.codeVerifier,
      credentialId: parsed.data.credentialId,
      secret: parsed.data.secret,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns the stable mobile protocol error contract.
    return mobileAppAuthErrorResponse(c, error, "ack");
  }
});

export default app;
