/**
 * Discord OAuth Callback API
 *
 * Handles the OAuth2 callback after user authorizes the bot.
 * For bot OAuth (scope=bot), Discord returns guild_id directly in URL params.
 */

import { Hono } from "hono";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
  resolveSafeRedirectTarget,
  sanitizeRelativeRedirectPath,
} from "@/lib/security/redirect-validation";
import { managedAgentDiscordService } from "@/lib/services/agent-managed-discord";
import { discordAutomationService } from "@/lib/services/discord-automation";
import type { OAuthState } from "@/lib/services/discord-automation/types";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const LOOPBACK_REDIRECT_ORIGINS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
] as const;

function resolveDiscordAvatarUrl(userId: string, avatarHash: string | null): string | undefined {
  if (!avatarHash) {
    return undefined;
  }
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`;
}

function resolveOAuthReturnTarget(
  baseUrl: string,
  returnUrl: string | undefined,
  managedFlow: boolean,
): URL {
  const fallbackPath = managedFlow
    ? "/dashboard/settings?tab=agents"
    : "/dashboard/settings?tab=connections";

  if (managedFlow && returnUrl) {
    if (returnUrl.startsWith("/")) {
      return new URL(sanitizeRelativeRedirectPath(returnUrl, fallbackPath), baseUrl);
    }

    try {
      return assertAllowedAbsoluteRedirectUrl(returnUrl, [
        ...getDefaultPlatformRedirectOrigins(),
        ...LOOPBACK_REDIRECT_ORIGINS,
      ]);
    } catch {
      // Fall through to standard same-origin fallback below.
    }
  }

  return resolveSafeRedirectTarget(returnUrl, baseUrl, fallbackPath);
}

app.get("/", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const guildId = c.req.query("guild_id");
  const permissions = c.req.query("permissions");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Parse state for return URL (do this early for error redirects)
  let decodedState: OAuthState | null = null;
  let returnTarget = resolveOAuthReturnTarget(baseUrl, undefined, false);
  if (state) {
    try {
      decodedState = discordAutomationService.decodeOAuthState(state);
      returnTarget = resolveOAuthReturnTarget(
        baseUrl,
        typeof decodedState.returnUrl === "string" ? decodedState.returnUrl : undefined,
        decodedState.flow === "agent-managed",
      );
    } catch {
      // Use default return URL
    }
  }

  function redirectWithStatus(
    status: "connected" | "error",
    params: Record<string, string>,
  ): Response {
    const target = new URL(returnTarget.toString());
    target.searchParams.set("discord", status);
    Object.entries(params).forEach(([key, value]) => {
      target.searchParams.set(key, value);
    });
    return Response.redirect(target.toString());
  }

  // Handle OAuth errors (user cancelled, etc.)
  if (error) {
    logger.warn("[Discord Callback] OAuth error", { error, errorDescription });
    return redirectWithStatus("error", {
      message: errorDescription || error,
    });
  }

  // For bot OAuth, guild_id is returned directly in URL params
  if (!guildId || !state || !code || !decodedState) {
    logger.warn("[Discord Callback] Missing params", {
      hasGuildId: !!guildId,
      hasState: !!state,
      hasCode: !!code,
      hasDecodedState: !!decodedState,
    });
    return redirectWithStatus("error", { message: "missing_params" });
  }

  try {
    const result = await discordAutomationService.handleBotOAuthCallback({
      code,
      guildId,
      oauthState: decodedState,
      permissions: permissions || undefined,
    });

    if (result.success) {
      if (
        decodedState.flow === "agent-managed" &&
        decodedState.agentId &&
        decodedState.organizationId &&
        decodedState.userId &&
        result.discordUser
      ) {
        const adminDiscordAvatarUrl = resolveDiscordAvatarUrl(
          result.discordUser.id,
          result.discordUser.avatar,
        );
        const connected = await managedAgentDiscordService.connectAgent({
          agentId: decodedState.agentId,
          organizationId: decodedState.organizationId,
          binding: {
            mode: "cloud-managed",
            applicationId: discordAutomationService.getApplicationId() ?? undefined,
            guildId: result.guildId ?? guildId,
            guildName: result.guildName || "",
            adminDiscordUserId: result.discordUser.id,
            adminDiscordUsername: result.discordUser.username,
            adminElizaUserId: decodedState.userId,
            connectedAt: new Date().toISOString(),
            ...(result.discordUser.globalName
              ? { adminDiscordDisplayName: result.discordUser.globalName }
              : {}),
            ...(adminDiscordAvatarUrl
              ? {
                  adminDiscordAvatarUrl,
                }
              : {}),
            ...(decodedState.botNickname?.trim()
              ? { botNickname: decodedState.botNickname.trim() }
              : {}),
          },
        });

        return redirectWithStatus("connected", {
          managed: "1",
          agentId: decodedState.agentId,
          guildId: result.guildId ?? guildId,
          guildName: result.guildName || "",
          restarted: connected.restarted ? "1" : "0",
        });
      }

      return redirectWithStatus("connected", {
        guildId: result.guildId ?? guildId,
        guildName: result.guildName || "",
      });
    } else {
      return redirectWithStatus("error", {
        message: result.error || "unknown",
      });
    }
  } catch (err) {
    logger.error("[Discord Callback] Unexpected error", {
      error: err instanceof Error ? err.message : "Unknown error",
    });
    return redirectWithStatus("error", { message: "callback_failed" });
  }
});

export default app;
