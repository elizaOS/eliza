// Handles v1 cloud API v1 twitter callback route traffic with route-local auth expectations.
import { Hono } from "hono";
import { cache } from "@/lib/cache/client";
import {
  getDefaultPlatformRedirectOrigins,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
} from "@/lib/security/redirect-validation";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import {
  clearOAuthSuccessParams,
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
} from "@/lib/services/oauth/success-proof";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function redirectErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

app.get("/", async (c) => {
  const oauthToken = c.req.query("oauth_token");
  const oauthVerifier = c.req.query("oauth_verifier");
  const denied = c.req.query("denied");
  const oauth2Code = c.req.query("code");
  const oauth2State = c.req.query("state");
  const oauth2Error = c.req.query("error");

  const baseUrl =
    c.env?.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://cloud.eliza.app";
  const defaultRedirectPath = "/cloud/settings?tab=connections";
  const allowedAbsoluteOrigins = [
    ...getDefaultPlatformRedirectOrigins(),
    ...LOOPBACK_REDIRECT_ORIGINS,
  ];

  function buildRedirectUrl(
    redirectUrl: string | undefined,
    params: Record<string, string>,
  ): URL {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: redirectUrl,
      baseUrl,
      fallbackPath: defaultRedirectPath,
      allowedAbsoluteOrigins,
    });
    if (rejected) {
      logger.error(
        "[Twitter Callback] SECURITY: Invalid redirect URL attempted",
        {
          redirectUrl,
        },
      );
    }

    // Always drop reserved OAuth success markers before writing callback params.
    // Error redirects must not retain a still-valid `proof` from a prior success
    // URL (AuthSuccessPage would verify it and show Connected). Unrelated caller
    // query state (e.g. `socket_connected`) is preserved.
    clearOAuthSuccessParams(target);

    Object.entries(params).forEach(([key, value]) => {
      target.searchParams.set(key, value);
    });

    return target;
  }

  function redirectTo(target: URL): Response {
    return Response.redirect(target.toString());
  }

  if (denied) {
    return redirectTo(
      buildRedirectUrl(undefined, {
        twitter_error: "authorization_denied",
      }),
    );
  }

  if (oauth2Error) {
    return redirectTo(
      buildRedirectUrl(undefined, {
        twitter_error: oauth2Error,
      }),
    );
  }

  if (oauth2Code || oauth2State) {
    if (!oauth2Code || !oauth2State) {
      return redirectTo(
        buildRedirectUrl(undefined, {
          twitter_error: "missing_oauth2_params",
        }),
      );
    }

    const stateKey = `twitter_oauth2:${oauth2State}`;
    const stateData = await cache.get(stateKey);
    if (!stateData) {
      return redirectTo(
        buildRedirectUrl(undefined, {
          twitter_error: "expired_or_invalid",
        }),
      );
    }

    let state: {
      codeVerifier: string;
      redirectUri: string;
      organizationId: string;
      userId: string;
      connectionRole?: "owner" | "agent";
      redirectUrl?: string;
    };

    try {
      const parsed =
        typeof stateData === "string" ? JSON.parse(stateData) : stateData;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.codeVerifier !== "string" ||
        typeof parsed.redirectUri !== "string" ||
        typeof parsed.organizationId !== "string" ||
        typeof parsed.userId !== "string"
      ) {
        throw new Error("Invalid OAuth2 state data structure");
      }
      state = {
        ...parsed,
        connectionRole: parsed.connectionRole === "agent" ? "agent" : "owner",
      };
    } catch (error) {
      logger.error("[Twitter Callback] Failed to parse OAuth2 state data", {
        error: error instanceof Error ? error.message : String(error),
      });
      await cache.del(stateKey);
      return redirectTo(
        buildRedirectUrl(undefined, {
          twitter_error: "invalid_state",
        }),
      );
    }

    await cache.del(stateKey);

    let tokens: Awaited<
      ReturnType<typeof twitterAutomationService.exchangeOAuth2Token>
    >;
    try {
      tokens = await twitterAutomationService.exchangeOAuth2Token(
        oauth2Code,
        state.codeVerifier,
        state.redirectUri,
      );
    } catch (error) {
      const detail = redirectErrorDetail(error);
      logger.error("[Twitter Callback] Failed to exchange OAuth2 token", {
        error: detail,
        organizationId: state.organizationId,
      });
      return redirectTo(
        buildRedirectUrl(state.redirectUrl, {
          twitter_error: "token_exchange_failed",
          twitter_error_detail: detail,
        }),
      );
    }

    try {
      await twitterAutomationService.storeCredentials(
        state.organizationId,
        state.userId,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          scope: tokens.scope,
          screenName: tokens.screenName,
          twitterUserId: tokens.userId,
          authMode: "oauth2",
        },
        state.connectionRole,
      );
    } catch (error) {
      logger.error("[Twitter Callback] Failed to store OAuth2 credentials", {
        error: error instanceof Error ? error.message : String(error),
        organizationId: state.organizationId,
      });
      return redirectTo(
        buildRedirectUrl(state.redirectUrl, {
          twitter_error: "storage_failed",
        }),
      );
    }

    await invalidateOAuthState(state.organizationId, "twitter", state.userId);
    const successParams: Record<string, string> = {
      twitter_connected: "true",
      platform: "twitter",
      twitter_role: state.connectionRole ?? "owner",
    };
    if (tokens.screenName) {
      successParams.twitter_username = tokens.screenName;
    }
    if (tokens.identityLookupError) {
      successParams.twitter_warning = "identity_lookup_failed";
      successParams.twitter_warning_detail = redirectErrorDetail(
        tokens.identityLookupError,
      );
    }
    const successTarget = buildRedirectUrl(state.redirectUrl, successParams);
    if (isOAuthSuccessLandingPath(successTarget.pathname)) {
      const proof = await mintOAuthSuccessProof({
        platform: "twitter",
        organizationId: state.organizationId,
        userId: state.userId,
      });
      if (proof) {
        successTarget.searchParams.set("proof", proof);
      } else {
        // Twitter has no connection_id — without a one-time bound proof the
        // success page cannot verify. Fail closed instead of a false Connected.
        logger.error(
          "[Twitter Callback] success proof secret/ticket unavailable; cannot verify /auth/success without a proof",
        );
        return redirectTo(
          buildRedirectUrl(state.redirectUrl, {
            twitter_error: "success_proof_unavailable",
          }),
        );
      }
    }
    return redirectTo(successTarget);
  }

  if (!oauthToken || !oauthVerifier) {
    return redirectTo(
      buildRedirectUrl(undefined, {
        twitter_error: "missing_params",
      }),
    );
  }

  const stateKey = `twitter_oauth:${oauthToken}`;
  const stateData = await cache.get(stateKey);

  if (!stateData) {
    return redirectTo(
      buildRedirectUrl(undefined, {
        twitter_error: "expired_or_invalid",
      }),
    );
  }

  let state: {
    oauthTokenSecret: string;
    organizationId: string;
    userId: string;
    connectionRole?: "owner" | "agent";
    redirectUrl?: string;
  };

  try {
    const parsed =
      typeof stateData === "string" ? JSON.parse(stateData) : stateData;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.oauthTokenSecret !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.userId !== "string"
    ) {
      throw new Error("Invalid state data structure");
    }

    state = {
      ...parsed,
      connectionRole: parsed.connectionRole === "agent" ? "agent" : "owner",
    };
  } catch (error) {
    logger.error("[Twitter Callback] Failed to parse state data", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cache.del(stateKey);
    return redirectTo(
      buildRedirectUrl(undefined, {
        twitter_error: "invalid_state",
      }),
    );
  }

  await cache.del(stateKey);

  const redirectUrl = state.redirectUrl;

  let tokens: Awaited<
    ReturnType<typeof twitterAutomationService.exchangeToken>
  >;
  try {
    tokens = await twitterAutomationService.exchangeToken(
      oauthToken,
      state.oauthTokenSecret,
      oauthVerifier,
    );
  } catch (error) {
    const detail = redirectErrorDetail(error);
    logger.error("[Twitter Callback] Failed to exchange token", {
      error: detail,
      organizationId: state.organizationId,
    });
    return redirectTo(
      buildRedirectUrl(redirectUrl, {
        twitter_error: "token_exchange_failed",
        twitter_error_detail: detail,
      }),
    );
  }

  try {
    await twitterAutomationService.storeCredentials(
      state.organizationId,
      state.userId,
      {
        accessToken: tokens.accessToken,
        accessSecret: tokens.accessSecret,
        screenName: tokens.screenName,
        twitterUserId: tokens.userId,
        authMode: "oauth1a",
      },
      state.connectionRole,
    );
  } catch (error) {
    logger.error("[Twitter Callback] Failed to store credentials", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: state.organizationId,
    });
    return redirectTo(
      buildRedirectUrl(redirectUrl, {
        twitter_error: "storage_failed",
      }),
    );
  }

  await invalidateOAuthState(state.organizationId, "twitter", state.userId);

  const oauth1Success: Record<string, string> = {
    twitter_connected: "true",
    platform: "twitter",
    twitter_username: tokens.screenName,
    twitter_role: state.connectionRole ?? "owner",
  };
  const oauth1Target = buildRedirectUrl(redirectUrl, oauth1Success);
  if (isOAuthSuccessLandingPath(oauth1Target.pathname)) {
    const oauth1Proof = await mintOAuthSuccessProof({
      platform: "twitter",
      organizationId: state.organizationId,
      userId: state.userId,
    });
    if (oauth1Proof) {
      oauth1Target.searchParams.set("proof", oauth1Proof);
    } else {
      logger.error(
        "[Twitter Callback] success proof secret/ticket unavailable; cannot verify /auth/success without a proof",
      );
      return redirectTo(
        buildRedirectUrl(redirectUrl, {
          twitter_error: "success_proof_unavailable",
        }),
      );
    }
  }

  return redirectTo(oauth1Target);
});

export default app;
