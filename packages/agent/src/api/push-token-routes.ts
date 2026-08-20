/**
 * Push-token routes.
 *
 * HTTP surface for a device to register/unregister its remote-push token so the
 * server can deliver notifications via APNs/FCM while the app is
 * backgrounded/killed. Tokens are owned by the `NotificationPushService`'s
 * `PushTokenRegistry`.
 *
 * Routes (all under /api/notifications/push-tokens so they ride next to the
 * notification rail, but they are handled HERE, not by notification-routes):
 *
 *   POST   /api/notifications/push-tokens
 *     Register (upsert) a device token. Body: { platform: "ios"|"android",
 *     token: string }. Returns `{ ok: true }`.
 *
 *   DELETE /api/notifications/push-tokens
 *     Unregister a device token from `{ token }`. The legacy token path remains
 *     accepted for installed clients, but new clients keep identifiers out of
 *     request URLs and access logs.
 *
 *   GET    /api/notifications/push-tokens
 *     Diagnostics: `{ count, platforms: { ios, android } }`.
 */

import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import {
  NOTIFICATION_PUSH_SERVICE_TYPE,
  NotificationPushService,
} from "../services/push/notification-push-service.ts";
import {
  MAX_PUSH_TOKEN_LENGTH,
  type PushPlatform,
  type PushTokenRegistry,
} from "../services/push/push-token-registry.ts";

export interface PushTokenRouteState {
  runtime: { getService: (type: string) => unknown } | null;
}

const PUSH_TOKENS_PREFIX = "/api/notifications/push-tokens";

function getRegistry(state: PushTokenRouteState): PushTokenRegistry | null {
  const svc = state.runtime?.getService(NOTIFICATION_PUSH_SERVICE_TYPE);
  return svc instanceof NotificationPushService ? svc.getRegistry() : null;
}

function parsePlatform(value: unknown): PushPlatform | null {
  return value === "ios" || value === "android" ? value : null;
}

export async function handlePushTokenRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: PushTokenRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith(PUSH_TOKENS_PREFIX)) return false;

  const registry = getRegistry(state);
  if (!registry) {
    helpers.error(res, "push delivery service not ready", 503);
    return true;
  }

  // ── GET /api/notifications/push-tokens ────────────────────────────
  if (method === "GET" && pathname === PUSH_TOKENS_PREFIX) {
    const tokens = await registry.list();
    let ios = 0;
    let android = 0;
    for (const record of tokens) {
      if (record.platform === "ios") ios++;
      else android++;
    }
    helpers.json(res, { count: tokens.length, platforms: { ios, android } });
    return true;
  }

  // ── POST /api/notifications/push-tokens ───────────────────────────
  if (method === "POST" && pathname === PUSH_TOKENS_PREFIX) {
    const body = await helpers.readJsonBody<Record<string, unknown>>(req, res, {
      maxBytes: 8 * 1024,
    });
    if (body === null) return true;
    const platform = parsePlatform(body.platform);
    if (!platform) {
      helpers.error(res, 'platform must be "ios" or "android"', 400);
      return true;
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      helpers.error(res, "token is required", 400);
      return true;
    }
    if (token.length > MAX_PUSH_TOKEN_LENGTH) {
      helpers.error(res, "token exceeds the length cap", 400);
      return true;
    }
    await registry.register(platform, token);
    helpers.json(res, { ok: true }, 201);
    return true;
  }

  // ── DELETE /api/notifications/push-tokens ─────────────────────────
  if (method === "DELETE" && pathname === PUSH_TOKENS_PREFIX) {
    const body = await helpers.readJsonBody<Record<string, unknown>>(req, res, {
      maxBytes: 8 * 1024,
    });
    if (body === null) return true;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      helpers.error(res, "token is required", 400);
      return true;
    }
    const ok = await registry.unregister(token);
    helpers.json(res, { ok });
    return true;
  }

  // ── Legacy DELETE /api/notifications/push-tokens/:token ───────────
  const tokenMatch = pathname.match(
    /^\/api\/notifications\/push-tokens\/([^/]+)$/,
  );
  if (method === "DELETE" && tokenMatch) {
    let token: string;
    try {
      token = decodeURIComponent(tokenMatch[1]);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed percent-encoding is invalid client input
      helpers.error(res, "invalid push token", 400);
      return true;
    }
    const ok = await registry.unregister(token);
    helpers.json(res, { ok });
    return true;
  }

  helpers.error(res, "push-token route not found", 404);
  return true;
}
