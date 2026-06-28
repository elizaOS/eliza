/**
 * Discord API Utilities
 *
 * Shared constants and helpers for Discord API interactions.
 * Consolidates duplicate Discord API base URLs and request patterns.
 */

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Create Discord Bot authorization header
 */
export function discordBotAuthHeader(token: string): string {
  return `Bot ${token}`;
}

/**
 * Create Discord Bearer authorization header (for OAuth)
 */
export function discordBearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Create Discord API request headers for bot requests
 */
export function discordBotHeaders(
  token: string,
  additionalHeaders?: Record<string, string>,
): HeadersInit {
  return {
    Authorization: discordBotAuthHeader(token),
    "Content-Type": "application/json",
    ...additionalHeaders,
  };
}

/**
 * Create Discord API request headers for OAuth requests
 */
export function discordBearerHeaders(
  token: string,
  additionalHeaders?: Record<string, string>,
): HeadersInit {
  return {
    Authorization: discordBearerAuthHeader(token),
    "Content-Type": "application/json",
    ...additionalHeaders,
  };
}

/**
 * Make a Discord API request with bot token
 */
export async function discordBotApiRequest<T>(
  endpoint: string,
  botToken: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...discordBotHeaders(botToken),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `Discord Bot API error: ${response.status} - ${error.message || "Unknown error"}`,
    );
  }

  return response.json();
}

/**
 * Make a Discord API request with OAuth bearer token
 */
export async function discordBearerApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...discordBearerHeaders(accessToken),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Discord API error: ${response.status} - ${error.message || "Unknown error"}`);
  }

  return response.json();
}
