// Handles v1 cloud API v1 twitter connect route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
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
      return c.json(
        { error: "Twitter integration is not configured on this platform" },
        503,
      );
    }

    const rawBody = await c.req.json().catch(() => ({}));
    // Role identity leftover after twitter-status (#21151) /
    // twitter-disconnect (#21144) / x-dms-digest (#21143). safeParse
    // failure used to collapse to {} and the ternary then mapped every
    // non-"agent" token — AGENT, owner-typos, 1e2 — onto the personal
    // owner OAuth connect. Missing/empty still defaults to owner.
    // Garbage 400s before generateAuthLink.
    const requestedRole =
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? (rawBody as { connectionRole?: unknown }).connectionRole
        : undefined;
    if (
      requestedRole !== undefined &&
      requestedRole !== "" &&
      requestedRole !== "agent" &&
      requestedRole !== "owner"
    ) {
      return c.json(
        {
          error: "invalid_connection_role",
          message:
            'connectionRole must be specified at most once as "agent" or "owner".',
        },
        400,
      );
    }
    const parsedBody = ConnectBody.safeParse(rawBody);
    const body = parsedBody.success ? parsedBody.data : {};
    const connectionRole = requestedRole === "agent" ? "agent" : "owner";
    const baseUrl =
      c.env?.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://cloud.eliza.app";
    const defaultRedirectPath = "/cloud/settings?tab=connections";
    const { target: safeRedirectTarget, rejected } =
      resolveOAuthSuccessRedirectUrl({
        value:
          typeof body.redirectUrl === "string" ? body.redirectUrl : undefined,
        baseUrl,
        fallbackPath: defaultRedirectPath,
        allowedAbsoluteOrigins: [
          ...getDefaultPlatformRedirectOrigins(),
          ...LOOPBACK_REDIRECT_ORIGINS,
        ],
      });
    if (rejected) {
      logger.warn("[Twitter Connect API] Rejected unsafe redirect URL", {
        redirectUrl:
          typeof body.redirectUrl === "string" ? body.redirectUrl : undefined,
      });
    }
    const redirectUrl = safeRedirectTarget.toString();
    const callbackUrl = `${baseUrl}/api/v1/twitter/callback`;

    let authLink: Awaited<
      ReturnType<typeof twitterAutomationService.generateAuthLink>
    >;
    try {
      authLink = await twitterAutomationService.generateAuthLink(
        callbackUrl,
        connectionRole,
      );
    } catch (error) {
      logger.error("[Twitter Connect API] Failed to generate auth link", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: "Twitter integration is currently unavailable" },
        503,
      );
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
