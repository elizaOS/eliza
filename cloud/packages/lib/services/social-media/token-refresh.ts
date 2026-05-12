import { requestTwitterOAuth2Token } from "@/lib/services/twitter-automation/oauth2-client";
import type { SocialCredentials, SocialPlatform } from "@/lib/types/social-media";
import { safeJsonParse } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export function isTokenExpired(credentials: SocialCredentials): boolean {
  if (!credentials.tokenExpiresAt) return false;
  return credentials.tokenExpiresAt.getTime() - TOKEN_EXPIRY_BUFFER_MS < Date.now();
}

export function needsRefresh(credentials: SocialCredentials): boolean {
  if (!credentials.tokenExpiresAt) return false;
  if (!credentials.refreshToken) return false;
  return isTokenExpired(credentials);
}

async function refreshTwitterToken(refreshToken: string): Promise<RefreshResult> {
  const data = await requestTwitterOAuth2Token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Twitter token refresh failed: missing access token");
  }

  const expiresIn =
    typeof data.expires_in === "number"
      ? data.expires_in
      : Number.isFinite(Number(data.expires_in))
        ? Number(data.expires_in)
        : undefined;

  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token.length > 0
        ? data.refresh_token
        : refreshToken,
    expiresAt:
      typeof expiresIn === "number" && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : undefined,
  };
}

async function refreshMetaToken(accessToken: string): Promise<RefreshResult> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) throw new Error("META_APP_ID or META_APP_SECRET not configured");

  const response = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: accessToken,
      }),
  );

  if (!response.ok) {
    const error = await safeJsonParse<{ error?: { message?: string } }>(response);
    throw new Error(error.error?.message || `Meta token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
  };
}

async function refreshLinkedInToken(refreshToken: string): Promise<RefreshResult> {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

  if (!clientId || !clientSecret)
    throw new Error("LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET not configured");

  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await safeJsonParse<{ error_description?: string }>(response);
    throw new Error(error.error_description || `LinkedIn token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

async function refreshTikTokToken(refreshToken: string): Promise<RefreshResult> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

  if (!clientKey || !clientSecret)
    throw new Error("TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET not configured");

  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_key: clientKey,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await safeJsonParse<{ error_description?: string }>(response);
    throw new Error(error.error_description || `TikTok token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function refreshToken(
  platform: SocialPlatform,
  credentials: SocialCredentials,
): Promise<RefreshResult | null> {
  logger.info(`[TokenRefresh] Refreshing ${platform} token`);

  switch (platform) {
    case "twitter":
      return credentials.refreshToken ? refreshTwitterToken(credentials.refreshToken) : null;
    case "facebook":
    case "instagram":
      return credentials.accessToken ? refreshMetaToken(credentials.accessToken) : null;
    case "linkedin":
      return credentials.refreshToken ? refreshLinkedInToken(credentials.refreshToken) : null;
    case "tiktok":
      return credentials.refreshToken ? refreshTikTokToken(credentials.refreshToken) : null;
    default:
      return null;
  }
}

export function getRefreshGuidance(platform: SocialPlatform): string {
  const guides: Record<SocialPlatform, string> = {
    twitter: "Re-authenticate your Twitter account at /settings/connections/twitter",
    bluesky: "Update your Bluesky app password at /settings/connections/bluesky",
    discord: "Check your Discord bot token at /settings/connections/discord",
    telegram: "Verify your Telegram bot token at /settings/connections/telegram",
    slack: "Re-install your Slack app or update bot token at /settings/connections/slack",
    reddit: "Check your Reddit app credentials at /settings/connections/reddit",
    facebook: "Re-authenticate your Facebook page at /settings/connections/facebook",
    instagram: "Re-authenticate your Instagram account at /settings/connections/instagram",
    tiktok: "Re-authenticate your TikTok account at /settings/connections/tiktok",
    linkedin: "Re-authenticate your LinkedIn account at /settings/connections/linkedin",
    mastodon: "Update your Mastodon access token at /settings/connections/mastodon",
  };
  return guides[platform];
}
