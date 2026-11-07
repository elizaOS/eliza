/**
 * POST /api/v1/eliza/google/connect/native
 *
 * Connects the signed-in owner's Google account from an Android
 * `serverAuthCode` instead of the browser OAuth round trip. The app gets the
 * code from `Identity.getAuthorizationClient().authorize(...)` with
 * `requestOfflineAccess(<Cloud GOOGLE_CLIENT_ID>, true)`; Cloud exchanges it
 * with its own web client (empty redirect_uri) and stores the connection
 * exactly as the OAuth callback does, with the scopes Google reports granted.
 *
 * Body: `{ "serverAuthCode": string }`. Owner credentials only (a session or
 * the owner's `eliza_mobile_` key); agent-side connections stay on the
 * browser flow.
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { connectionEnforcementService } from "@elizaos/cloud-shared/lib/services/eliza-app";
import { invalidateOAuthState } from "@elizaos/cloud-shared/lib/services/oauth/invalidation";
import {
  getProvider,
  isProviderConfigured,
} from "@elizaos/cloud-shared/lib/services/oauth/provider-registry";
import { exchangeGoogleServerAuthCode } from "@elizaos/cloud-shared/lib/services/oauth/providers";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Google authorization codes, e.g. `4/0AeaY...`. */
const requestSchema = z
  .object({
    serverAuthCode: z
      .string()
      .min(10)
      .max(2048)
      .regex(/^[A-Za-z0-9/_.~-]+$/),
  })
  .strict();

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    await requirePrivateOwnerAccess(c, user);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json(
        { error: "The request body must be JSON.", code: "invalid_request" },
        400,
        NO_STORE,
      );
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: "serverAuthCode is required.", code: "invalid_request" },
        400,
        NO_STORE,
      );
    const provider = getProvider("google");
    if (!provider || !isProviderConfigured(provider))
      return c.json(
        {
          error: "Google is not configured on this Cloud.",
          code: "google_not_configured",
        },
        503,
        NO_STORE,
      );
    let result: Awaited<ReturnType<typeof exchangeGoogleServerAuthCode>>;
    try {
      result = await exchangeGoogleServerAuthCode(provider, {
        organizationId: user.organization_id,
        userId: user.id,
        serverAuthCode: parsed.data.serverAuthCode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /^Token exchange failed: (\d{3})$/.exec(message)?.[1];
      if (status && Number(status) < 500) {
        // Used, expired, or issued to another client: the app must authorize again.
        return c.json(
          {
            error: "Google refused this authorization code. Authorize again.",
            code: "google_code_rejected",
          },
          400,
          NO_STORE,
        );
      }
      if (message === "GOOGLE_GRANTED_SCOPES_REQUIRED")
        return c.json(
          {
            error: "Google did not report any granted scopes.",
            code: "google_scopes_missing",
          },
          400,
          NO_STORE,
        );
      if (status)
        return c.json(
          {
            error: "Google is unavailable. Try again.",
            code: "google_unavailable",
          },
          502,
          NO_STORE,
        );
      throw error;
    }
    try {
      await Promise.all([
        invalidateOAuthState(result.organizationId, "google", result.userId),
        connectionEnforcementService.invalidateRequiredConnectionCache(
          result.organizationId,
          result.userId,
        ),
      ]);
    } catch (error) {
      logger.warn("[Google native connect] Cache invalidation failed", {
        error: String(error),
      });
    }
    return c.json(
      {
        connected: true,
        connectionId: result.connectionId,
        email: result.email ?? null,
        displayName: result.displayName ?? null,
        scopes: result.scopes,
        refreshTokenIssued: result.refreshTokenIssued,
      },
      200,
      NO_STORE,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
