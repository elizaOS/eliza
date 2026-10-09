/**
 * Embedded-app launch auth route (#9947) — the reachable HTTP seam in front of
 * the shared `verifyEmbedLaunch` handshake. A Discord Activity / Telegram Mini
 * App POSTs its signed launch payload here; the route verifies it server-side
 * (HMAC / OAuth2), maps it to a role-gated principal, and fails closed on
 * anything that is not an OWNER/ADMIN with a valid signature.
 *
 *   POST /api/embed/auth   { platform, signedLaunchPayload, accountId? }
 *     → 200 { entityId, role, adminMode }   (verified OWNER/ADMIN)
 *     → 403 { error }                        (bad signature / replay / sub-ADMIN)
 *     → 400 { error }                        (missing/invalid input)
 *     → 503 { error }                        (agent not running)
 *
 * The scoped, Steward-compatible session token is minted by the caller from the
 * returned principal — this seam performs verification + role resolution only.
 */

import type http from "node:http";
import { resolveDiscordExchange } from "./auth/discord-exchange";
import { type EmbedPlatform, verifyEmbedLaunch } from "./auth/embed-handshake";
import {
  DEFAULT_EMBED_TOKEN_TTL_MS,
  mintEmbedSessionToken,
  resolveEmbedSessionSecretForRuntime,
} from "./auth/embed-session-token";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

function isEmbedPlatform(value: unknown): value is EmbedPlatform {
  return value === "telegram" || value === "discord";
}

export async function handleEmbedAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  // Injectable so tests exercise the route without a module mock for the
  // handshake — module mocks race under vmForks parallel load. Each field
  // defaults to the real implementation in production.
  deps: {
    verifyEmbedLaunch?: typeof verifyEmbedLaunch;
    resolveDiscordExchange?: typeof resolveDiscordExchange;
  } = {},
): Promise<boolean> {
  const verify = deps.verifyEmbedLaunch ?? verifyEmbedLaunch;
  const resolveExchange = deps.resolveDiscordExchange ?? resolveDiscordExchange;
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "POST" || url.pathname !== "/api/embed/auth") {
    return false;
  }

  const runtime = state.current;
  if (!runtime) {
    sendJsonErrorResponse(res, 503, "Agent runtime not available");
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (body == null) {
    return true;
  }

  const platform = body.platform;
  const signedLaunchPayload = body.signedLaunchPayload;
  if (!isEmbedPlatform(platform) || typeof signedLaunchPayload !== "string") {
    sendJsonErrorResponse(
      res,
      400,
      "platform ('telegram'|'discord') and signedLaunchPayload are required",
    );
    return true;
  }
  const accountId =
    typeof body.accountId === "string" ? body.accountId : undefined;

  // Discord verification exchanges the Activity OAuth2 code server-side; resolve
  // the production exchange from the runtime's configured credentials. When the
  // credentials are unset this is `undefined` and the handshake fails closed
  // with `discord_exchange_unconfigured`. Telegram never needs an exchange, so
  // its input is left untouched.
  const input =
    platform === "discord"
      ? {
          platform,
          signedLaunchPayload,
          accountId,
          discordExchange: resolveExchange(runtime),
        }
      : { platform, signedLaunchPayload, accountId };

  const result = await verify(input, runtime);

  if (!result.ok) {
    // Fail closed: never echo the raw reason in a way that leaks why the
    // signature failed beyond the coarse 403 the handshake already decided.
    sendJsonErrorResponse(res, result.status, result.reason);
    return true;
  }

  // Mint the scoped, short-lived embed session token the cross-origin SPA will
  // present back (first-party Steward cookies do not cross into the iframe).
  const secret = resolveEmbedSessionSecretForRuntime(runtime);
  const expiresAt = Date.now() + DEFAULT_EMBED_TOKEN_TTL_MS;
  const token = secret
    ? mintEmbedSessionToken(
        {
          entityId: result.entityId,
          role: result.role,
          adminMode: result.adminMode,
          exp: expiresAt,
        },
        secret,
      )
    : null;

  sendJsonResponse(res, 200, {
    entityId: result.entityId,
    role: result.role,
    adminMode: result.adminMode,
    token,
    expiresAt: token ? expiresAt : null,
  });
  return true;
}
