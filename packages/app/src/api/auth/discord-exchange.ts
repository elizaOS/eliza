/**
 * Production Discord Activity token exchange (#9947).
 *
 * The embed-launch handshake (`verifyEmbedLaunch`) verifies a Discord Activity
 * by exchanging its OAuth2 authorization `code` for an access token server-side
 * and reading the authenticated user id. The exchange is dependency-injected so
 * the handshake stays pure and unit-testable; this module supplies the real
 * implementation the HTTP route wires in.
 *
 * Flow (Discord Embedded App SDK): the Activity iframe calls
 * `discordSdk.commands.authorize()` which returns a `code`; the client POSTs it
 * to `/api/embed/auth`; this exchange turns `code` → access token → `/users/@me`.
 * No `redirect_uri` is required for the Activity authorization-code grant.
 *
 * SECURITY: `DISCORD_CLIENT_SECRET` is used only in the token-exchange request
 * body. It is never logged, never returned, and never attached to an error. The
 * exchange fails closed (returns `null`) on every failure path so the handshake
 * rejects the launch with a coarse 403.
 */

import { logger } from "@elizaos/core";
import type { DiscordExchange, DiscordVerifiedUser } from "./embed-handshake";

const DISCORD_TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface DiscordExchangeDeps {
  /** Injectable fetch (defaults to the Node global) for deterministic tests. */
  fetch?: FetchLike;
  /** Overridable endpoints for tests; default to the real Discord API. */
  tokenUrl?: string;
  userUrl?: string;
}

function readSetting(
  runtime: { getSetting?: (key: string) => unknown },
  key: string,
): string {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve the production Discord exchange from the runtime's configured
 * credentials, or `undefined` when they are not set — in which case the
 * handshake fails closed with `discord_exchange_unconfigured` rather than
 * attempting an unauthenticated exchange.
 *
 * `client_id` comes from `DISCORD_APPLICATION_ID` (the same id the connector
 * uses to build its install URL), falling back to `DISCORD_CLIENT_ID`.
 */
export function resolveDiscordExchange(
  runtime: { getSetting?: (key: string) => unknown },
  deps: DiscordExchangeDeps = {},
): DiscordExchange | undefined {
  const clientId =
    readSetting(runtime, "DISCORD_APPLICATION_ID") ||
    readSetting(runtime, "DISCORD_CLIENT_ID");
  const clientSecret = readSetting(runtime, "DISCORD_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return undefined;
  }

  const doFetch: FetchLike = deps.fetch ?? fetch;
  const tokenUrl = deps.tokenUrl ?? DISCORD_TOKEN_URL;
  const userUrl = deps.userUrl ?? DISCORD_USER_URL;

  return async (code: string): Promise<DiscordVerifiedUser | null> => {
    if (!code) {
      return null;
    }

    let accessToken: string;
    try {
      const tokenRes = await doFetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
        }).toString(),
      });
      if (!tokenRes.ok) {
        logger.warn(
          { status: tokenRes.status },
          "[DiscordEmbedExchange] token exchange rejected (fail closed)",
        );
        return null;
      }
      const tokenData = (await tokenRes.json()) as { access_token?: unknown };
      if (
        typeof tokenData.access_token !== "string" ||
        tokenData.access_token.length === 0
      ) {
        return null;
      }
      accessToken = tokenData.access_token;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[DiscordEmbedExchange] token request failed (fail closed)",
      );
      return null;
    }

    try {
      const userRes = await doFetch(userUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) {
        logger.warn(
          { status: userRes.status },
          "[DiscordEmbedExchange] user lookup rejected (fail closed)",
        );
        return null;
      }
      const user = (await userRes.json()) as { id?: unknown };
      if (typeof user.id !== "string" || user.id.length === 0) {
        return null;
      }
      return { id: user.id };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[DiscordEmbedExchange] user request failed (fail closed)",
      );
      return null;
    }
  };
}
