import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { fetchHonoRoot } from "@/lib/api/hono-root-request";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { cache } from "@/lib/cache/client";
import {
  getDefaultPlatformRedirectOrigins,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
} from "@/lib/security/redirect-validation";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const ConnectBody = z.object({
  connectionRole: z.enum(["agent", "owner"]).optional(),
  redirectUrl: z.string().optional(),
});

app.post("/", async (c) => {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);

    if (!twitterAutomationService.isConfigured()) {
      return c.json({ error: "Twitter integration is not configured on this platform" }, 503);
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const parsedBody = ConnectBody.safeParse(rawBody);
    const body = parsedBody.success ? parsedBody.data : {};
    const connectionRole = body.connectionRole === "agent" ? "agent" : "owner";
    const baseUrl =
      c.env?.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    const defaultRedirectPath = "/dashboard/settings?tab=connections";
    const { target: safeRedirectTarget, rejected } = resolveOAuthSuccessRedirectUrl({
      value: typeof body.redirectUrl === "string" ? body.redirectUrl : undefined,
      baseUrl,
      fallbackPath: defaultRedirectPath,
      allowedAbsoluteOrigins: [
        ...getDefaultPlatformRedirectOrigins(),
        ...LOOPBACK_REDIRECT_ORIGINS,
      ],
    });
    if (rejected) {
      logger.warn("[Twitter Connect API] Rejected unsafe redirect URL", {
        redirectUrl: typeof body.redirectUrl === "string" ? body.redirectUrl : undefined,
      });
    }
    const redirectUrl = safeRedirectTarget.toString();
    const callbackUrl = `${baseUrl}/api/v1/twitter/callback`;

    let authLink;
    try {
      authLink = await twitterAutomationService.generateAuthLink(callbackUrl, connectionRole);
    } catch (error) {
      logger.error("[Twitter Connect API] Failed to generate auth link", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Twitter integration is currently unavailable" }, 503);
    }

    if (authLink.flow === "oauth1a") {
      await cache.set(
        `twitter_oauth:${authLink.oauthToken}`,
        JSON.stringify({
          oauthTokenSecret: authLink.oauthTokenSecret,
          organizationId: user.organization_id,
          userId: user.id,
          connectionRole,
          redirectUrl,
        }),
        600,
      );
    } else {
      await cache.set(
        `twitter_oauth2:${authLink.state}`,
        JSON.stringify({
          codeVerifier: authLink.codeVerifier,
          redirectUri: authLink.redirectUri,
          organizationId: user.organization_id,
          userId: user.id,
          connectionRole,
          redirectUrl,
        }),
        600,
      );
    }

    return c.json({
      authUrl: authLink.url,
      oauthToken: authLink.flow === "oauth1a" ? authLink.oauthToken : undefined,
      state: authLink.flow === "oauth2" ? authLink.state : undefined,
      flow: authLink.flow,
      connectionRole,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

export const POST = (request: Request) => fetchHonoRoot(app, request);
