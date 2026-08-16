// Handles v1 cloud API v1 twitter token route traffic with route-local auth expectations.
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/**
 * GET /api/v1/twitter/token?connectionRole=agent|owner
 *
 * Vends the current X (Twitter) access credentials for the caller's
 * organization, in the shape expected by `@elizaos/plugin-x`'s
 * BrokerAuthProvider:
 *
 *   OAuth 1.0a:
 *     {
 *       "auth_mode": "oauth1",
 *       "consumer_key": "...",
 *       "consumer_secret": "...",
 *       "access_token": "...",
 *       "access_token_secret": "..."
 *     }
 *
 *   OAuth 2.0 user-context:
 *     {
 *       "auth_mode": "oauth2",
 *       "access_token": "...",
 *       "expires_at": 1735689600
 *     }
 *
 * OAuth 2.0 tokens are refreshed server-side before vending whenever the
 * stored token is expired (or has no recorded expiry) and a refresh token is
 * available, so the response always carries a live token plus its
 * `expires_at` deadline when X reported one.
 *
 * Auth: standard Cloud auth (Bearer JWT, eliza_* API key, or X-API-Key) — same
 * as every other v1 route. The authenticated user/org owns the X connection
 * being read.
 */
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    // The owner connection is the user's PERSONAL X account. Vending it must
    // be an explicit, well-formed request — never the fallthrough for a
    // missing or mistyped parameter (the prior ternary mapped every
    // non-"agent" value, including typos and absence, to "owner"). Missing
    // defaults to the least-privileged agent connection; garbage is a 400,
    // not a silent privilege escalation.
    const requestedRole = c.req.query("connectionRole");
    if (
      requestedRole !== undefined &&
      requestedRole !== "agent" &&
      requestedRole !== "owner"
    ) {
      return c.json(
        {
          error: "invalid_connection_role",
          message: 'connectionRole must be "agent" or "owner".',
        },
        400,
      );
    }
    const role: "agent" | "owner" = requestedRole ?? "agent";

    const coordinator = c.env.TWITTER_OAUTH_REFRESH_COORDINATORS;
    if (!coordinator) {
      return c.json(
        {
          error: "x_credential_coordinator_unavailable",
          message: "X credential coordinator is unavailable.",
        },
        503,
      );
    }
    const response = await coordinator
      .getByName(`${user.organization_id}:${role}`)
      .fetch("https://twitter-oauth.internal/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: user.organization_id,
          userId: user.id,
          connectionRole: role,
        }),
      });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
