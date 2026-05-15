import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
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
 * Auth: standard Cloud auth (Bearer JWT, eliza_* API key, or X-API-Key) — same
 * as every other v1 route. The authenticated user/org owns the X connection
 * being read.
 */
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const role = c.req.query("connectionRole") === "owner" ? "owner" : ("agent" as const);

    const creds = await twitterAutomationService.getCredentialsForAgent(user.organization_id, role);

    if (!creds) {
      return c.json(
        {
          error: "no_x_connection",
          message:
            "No X (Twitter) connection found for this organization. Connect via the connectors page.",
          connectionRole: role,
        },
        404,
      );
    }

    if (creds.TWITTER_AUTH_MODE === "oauth1a") {
      return c.json({
        auth_mode: "oauth1" as const,
        consumer_key: creds.TWITTER_API_KEY,
        consumer_secret: creds.TWITTER_API_SECRET_KEY,
        access_token: creds.TWITTER_ACCESS_TOKEN,
        access_token_secret: creds.TWITTER_ACCESS_TOKEN_SECRET,
        ...(creds.TWITTER_USER_ID ? { user_id: creds.TWITTER_USER_ID } : {}),
      });
    }

    if (creds.TWITTER_AUTH_MODE === "oauth2") {
      return c.json({
        auth_mode: "oauth2" as const,
        access_token: creds.TWITTER_OAUTH_ACCESS_TOKEN,
        ...(creds.TWITTER_OAUTH_SCOPE ? { scopes: creds.TWITTER_OAUTH_SCOPE } : {}),
        ...(creds.TWITTER_USER_ID ? { user_id: creds.TWITTER_USER_ID } : {}),
      });
    }

    return c.json(
      {
        error: "unsupported_auth_mode",
        message: `Stored TWITTER_AUTH_MODE=${creds.TWITTER_AUTH_MODE} is not supported by the broker endpoint.`,
      },
      500,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
