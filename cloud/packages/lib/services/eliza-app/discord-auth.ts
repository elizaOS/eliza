/**
 * Discord OAuth2 Authentication Service
 *
 * Exchanges OAuth2 authorization codes for access tokens and fetches user profiles.
 * See: https://discord.com/developers/docs/topics/oauth2
 */

import { logger } from "@/lib/utils/logger";
import { elizaAppConfig } from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Discord user data returned after OAuth2 verification
 */
export interface DiscordUserData {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

/**
 * Discord OAuth2 token response
 */
interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Discord API user response
 */
interface DiscordApiUser {
  id: string;
  username: string;
  discriminator: string;
  global_name: string | null;
  avatar: string | null;
  bot?: boolean;
  system?: boolean;
}

class DiscordAuthService {
  /**
   * Exchange an OAuth2 authorization code for an access token,
   * then fetch the Discord user profile.
   *
   * @param code - The authorization code from Discord OAuth2 redirect
   * @param redirectUri - The redirect_uri used in the original authorization request
   * @returns Discord user data, or null if verification fails
   */
  async verifyOAuthCode(code: string, redirectUri: string): Promise<DiscordUserData | null> {
    const { applicationId, clientSecret } = elizaAppConfig.discord;

    if (!applicationId || !clientSecret) {
      logger.error("[DiscordAuth] Application ID or client secret not configured");
      return null;
    }

    // Step 1: Exchange authorization code for access token
    let tokenData: DiscordTokenResponse;
    try {
      const tokenResponse = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: applicationId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.warn("[DiscordAuth] Token exchange failed", {
          status: tokenResponse.status,
          error: errorText.slice(0, 200),
        });
        return null;
      }

      const rawToken = (await tokenResponse.json()) as Partial<DiscordTokenResponse>;
      if (!rawToken.access_token) {
        logger.error("[DiscordAuth] Invalid token response - missing access_token");
        return null;
      }
      tokenData = rawToken as DiscordTokenResponse;
    } catch (error) {
      logger.error("[DiscordAuth] Token exchange request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    // Step 2: Fetch user profile using the access token
    try {
      const userResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      });

      if (!userResponse.ok) {
        const errorText = await userResponse.text();
        logger.warn("[DiscordAuth] User profile fetch failed", {
          status: userResponse.status,
          error: errorText.slice(0, 200),
        });
        return null;
      }

      const discordUser = (await userResponse.json()) as DiscordApiUser;

      // Validate required fields
      if (!discordUser.id || !discordUser.username) {
        logger.warn("[DiscordAuth] Missing required user fields", {
          hasId: !!discordUser.id,
          hasUsername: !!discordUser.username,
        });
        return null;
      }

      // Reject bot/system accounts
      if (discordUser.bot || discordUser.system) {
        logger.warn("[DiscordAuth] Bot or system account rejected", {
          id: discordUser.id,
          bot: discordUser.bot,
          system: discordUser.system,
        });
        return null;
      }

      return {
        id: discordUser.id,
        username: discordUser.username,
        global_name: discordUser.global_name,
        avatar: discordUser.avatar,
      };
    } catch (error) {
      logger.error("[DiscordAuth] User profile request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Build the avatar URL from Discord user data.
   * Returns null if the user has no avatar.
   */
  getAvatarUrl(userId: string, avatarHash: string | null): string | null {
    if (!avatarHash) return null;
    const ext = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
  }

  /**
   * Extract user display name from Discord user data.
   */
  getDisplayName(data: DiscordUserData): string {
    return data.global_name || data.username;
  }
}

export const discordAuthService = new DiscordAuthService();
