/**
 * Discord OAuth2 Authentication Service
 *
 * Exchanges OAuth2 authorization codes for access tokens and fetches user profiles.
 * See: https://discord.com/developers/docs/topics/oauth2
 */

import { logger } from "../../utils/logger";
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
   * Exchange an OAuth2 authorization code for an access token, then fetch the
   * Discord user profile.
   *
   * Returns `null` ONLY for a genuine authentication denial the caller renders
   * as "invalid code": Discord rejects the grant (HTTP 400 `invalid_grant` —
   * expired/reused/wrong code), or the resolved account is a bot/system account.
   * Every other failure — unconfigured client credentials, a Discord 401/403/5xx
   * (our misconfig or a Discord outage), a malformed response, or a transport
   * error — is an internal failure and THROWS so the route boundary surfaces it
   * as a 5xx. Collapsing those into `null` would mask a broken pipeline as the
   * user's bad code.
   *
   * @param code - The authorization code from Discord OAuth2 redirect
   * @param redirectUri - The redirect_uri used in the original authorization request
   * @returns Discord user data, or null when the code/account is rejected
   */
  async verifyOAuthCode(code: string, redirectUri: string): Promise<DiscordUserData | null> {
    const { applicationId, clientSecret } = elizaAppConfig.discord;

    if (!applicationId || !clientSecret) {
      throw new Error("[DiscordAuth] Discord application id or client secret not configured");
    }

    // Step 1: Exchange the authorization code for an access token.
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
      // 400 is Discord rejecting the grant itself (expired/reused/wrong code) —
      // the one genuine auth denial. Any other status is our misconfigured
      // credentials or a Discord outage: an internal failure, not the user's code.
      if (tokenResponse.status === 400) {
        logger.warn("[DiscordAuth] Authorization code rejected by Discord", {
          status: tokenResponse.status,
          error: errorText.slice(0, 200),
        });
        return null;
      }
      logger.error("[DiscordAuth] Token exchange failed", {
        status: tokenResponse.status,
        error: errorText.slice(0, 200),
      });
      throw new Error(
        `[DiscordAuth] Discord token endpoint returned status ${tokenResponse.status}`,
      );
    }

    const rawToken = (await tokenResponse.json()) as Partial<DiscordTokenResponse>;
    if (!rawToken.access_token) {
      throw new Error("[DiscordAuth] Discord token response missing access_token");
    }
    const tokenData = rawToken as DiscordTokenResponse;

    // Step 2: Fetch the user profile with the access token. We now hold a valid
    // token, so any failure here is internal (transport/Discord/protocol) — never
    // a user-supplied-code problem — and must surface, not degrade to "invalid code".
    const userResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      logger.error("[DiscordAuth] User profile fetch failed", {
        status: userResponse.status,
        error: errorText.slice(0, 200),
      });
      throw new Error(`[DiscordAuth] Discord user endpoint returned status ${userResponse.status}`);
    }

    const discordUser = (await userResponse.json()) as DiscordApiUser;

    if (!discordUser.id || !discordUser.username) {
      throw new Error("[DiscordAuth] Discord user response missing required fields");
    }

    // Bot/system accounts are a designed rejection, distinct from a failure.
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
