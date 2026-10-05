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
 *     token: string }. Returns `{ ok: true, deliveryEnabled: boolean }`.
 *
 *   DELETE /api/notifications/push-tokens
 *     Unregister a device token from `{ token }`.
 *
 *   GET    /api/notifications/push-tokens
 *     Diagnostics: `{ count, platforms: { ios, android } }`.
 */
import type http from "node:http";
import type { RouteHelpers } from "@elizaos/host/protocol";
import {
  NOTIFICATION_PUSH_SERVICE_TYPE,
  NotificationPushService,
} from "../services/push/notification-push-service.ts";
import {
  isPushTokenValidationError,
  type PushPlatform,
  type PushTokenRegistry,
} from "../services/push/push-token-registry.ts";
export interface PushTokenRouteState {
  runtime: {
    getService: (type: string) => unknown;
  } | null;
}
const PUSH_TOKENS_PREFIX = "/api/notifications/push-tokens";
function getPushService(
  state: PushTokenRouteState,
): NotificationPushService | null {
  const svc = state.runtime?.getService(NOTIFICATION_PUSH_SERVICE_TYPE);
  return svc instanceof NotificationPushService ? svc : null;
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
  const service = getPushService(state);
  const registry = service?.getRegistry();
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
    // The registry re-validates the token (byte cap included). A typed
    // validation failure is a client error (400); a durable-write failure
    // propagates and the server boundary maps it to 500.
    try {
      await registry.register(
        platform,
        token,
        body.reminderDataNotifications as boolean | undefined,
      );
    } catch (err) {
      // error-policy:J4 user-facing degrade — only the expected validation
      // shape becomes a 400; every other failure rethrows to the 500 boundary.
      if (isPushTokenValidationError(err)) {
        helpers.error(res, "invalid push token", 400);
        return true;
      }
      throw err;
    }
    helpers.json(
      res,
      {
        ok: true,
        deliveryEnabled: service?.isDeliveryEnabled(platform) === true,
      },
      201,
    );
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
    return unregisterOrError(registry, token, res, helpers);
  }
  helpers.error(res, "push-token route not found", 404);
  return true;
}
/**
 * Run `registry.unregister`, applying the same byte-bound validation as the
 * register path. A typed validation failure maps to
 * 400; a durable-write failure rethrows to the server's 500 boundary.
 */
async function unregisterOrError(
  registry: PushTokenRegistry,
  token: string,
  res: http.ServerResponse,
  helpers: RouteHelpers,
): Promise<boolean> {
  try {
    const ok = await registry.unregister(token);
    helpers.json(res, { ok });
  } catch (err) {
    // error-policy:J4 user-facing degrade — expected validation shape → 400;
    // anything else rethrows so genuine persistence failures surface as 500.
    if (isPushTokenValidationError(err)) {
      helpers.error(res, "invalid push token", 400);
      return true;
    }
    throw err;
  }
  return true;
}
