/**
 * Push-token and push-policy routes.
 *
 * HTTP surface for a device to register/unregister its remote-push token so the
 * server can deliver notifications via APNs/FCM while the app is
 * backgrounded/killed, and for a principal to read/update the per-principal
 * inbox-before-push policy (#23106). Tokens and policies are owned by the
 * `NotificationPushService`'s `PushTokenRegistry` / `PushPolicyStore`.
 *
 * Routes (all under /api/notifications so they ride next to the notification
 * rail, but they are handled HERE, not by notification-routes):
 *
 *   POST   /api/notifications/push-tokens
 *     Register (upsert) a device token. Body: { platform: "ios"|"android",
 *     token: string, ownerEntityId?: string }. When `ownerEntityId` is absent
 *     the server binds the token to the runtime's canonical owner when one is
 *     configured; with no resolvable owner the token registers UNOWNED, and
 *     unowned tokens never receive pushes (fail-closed recipient binding,
 *     #23106). Returns `{ ok: true }`.
 *
 *   DELETE /api/notifications/push-tokens
 *     Unregister a device token from `{ token }`. The legacy token path remains
 *     accepted for installed clients, but new clients keep identifiers out of
 *     request URLs and access logs.
 *
 *   GET    /api/notifications/push-tokens
 *     Diagnostics: `{ count, platforms: { ios, android } }`.
 *
 *   GET    /api/notifications/push-policy
 *     Read the calling canonical owner's push policy. Returns
 *     `{ policy: { pushEnabled, version, updatedAt } | null }` — `null` means
 *     no policy exists yet, which the delivery seam treats as inbox-only.
 *
 *   PUT    /api/notifications/push-policy
 *     Upsert the calling canonical owner's push policy from
 *     `{ pushEnabled: boolean }`. Bumps `version`, stamps `updatedAt`. Returns
 *     the persisted policy.
 */

import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import { logger, resolveCanonicalOwnerId } from "@elizaos/core";
import {
  NOTIFICATION_PUSH_SERVICE_TYPE,
  NotificationPushService,
} from "../services/push/notification-push-service.ts";
import {
  type PushDeliveryPolicy,
  type PushPolicyStore,
  parsePushDeliveryPolicy,
} from "../services/push/push-policy.ts";
import {
  isPushTokenValidationError,
  type PushPlatform,
  type PushTokenRegistry,
} from "../services/push/push-token-registry.ts";

export interface PushTokenRouteState {
  runtime:
    | ({ getService: (type: string) => unknown } & Partial<
        Pick<Parameters<typeof resolveCanonicalOwnerId>[0], "getSetting">
      >)
    | null;
}

const PUSH_TOKENS_PREFIX = "/api/notifications/push-tokens";
const PUSH_POLICY_PATH = "/api/notifications/push-policy";

function getRegistry(state: PushTokenRouteState): PushTokenRegistry | null {
  const svc = state.runtime?.getService(NOTIFICATION_PUSH_SERVICE_TYPE);
  return svc instanceof NotificationPushService ? svc.getRegistry() : null;
}

function getPolicies(state: PushTokenRouteState): PushPolicyStore | null {
  const svc = state.runtime?.getService(NOTIFICATION_PUSH_SERVICE_TYPE);
  return svc instanceof NotificationPushService ? svc.getPolicies() : null;
}

/**
 * Resolve the recipient a registration/policy write applies to: an explicit
 * caller-supplied entity id, else the runtime's canonical owner, else null
 * (the caller surfaces the distinct unresolvable state; nothing is guessed).
 */
/**
 * Outcome of resolving the principal a registration applies to. `invalid`
 * means the caller SUPPLIED an ownerEntityId that is malformed or does not
 * match the server-established canonical owner — at an untrusted HTTP boundary
 * a present-but-wrong field is a client error, not a silent default.
 */
export type PrincipalResolution =
  | { resolved: true; principalId: string }
  | { resolved: false; reason: "unresolvable" }
  | { resolved: false; reason: "invalid" };

/**
 * Resolve the principal a registration applies to. An explicit ownerEntityId
 * is accepted ONLY when it equals the runtime's canonical owner — this HTTP
 * surface has no per-caller identity beyond the server auth boundary, so an
 * authenticated caller must not bind a device to ANOTHER principal's push
 * stream (#23106: a body-supplied id is not authorization). With no explicit
 * id the canonical owner is used; with no resolvable canonical owner the token
 * registers unowned (delivery fails closed; nothing is guessed).
 */
function resolveRegistrationPrincipal(
  state: PushTokenRouteState,
  explicit: unknown,
): PrincipalResolution {
  let explicitId: string | undefined;
  if (explicit !== undefined) {
    // Only a truly absent field means omission. A supplied null/number/blank
    // is a present-but-malformed field: client error, never a silent default
    // to the canonical owner.
    if (typeof explicit !== "string" || explicit.trim().length === 0) {
      return { resolved: false, reason: "invalid" };
    }
    explicitId = explicit.trim();
  }
  const canonical =
    state.runtime && typeof state.runtime.getSetting === "function"
      ? resolveCanonicalOwnerId(
          state.runtime as Parameters<typeof resolveCanonicalOwnerId>[0],
        )
      : null;
  if (explicitId !== undefined) {
    if (canonical === null || explicitId !== canonical) {
      // No server-established principal authorizes this explicit id.
      return { resolved: false, reason: "invalid" };
    }
    return { resolved: true, principalId: explicitId };
  }
  if (canonical === null) return { resolved: false, reason: "unresolvable" };
  return { resolved: true, principalId: canonical };
}

/**
 * Resolve the canonical owner for the policy routes (no explicit id accepted —
 * a principal reads and writes only their own push policy).
 */
function resolvePolicyPrincipal(state: PushTokenRouteState): string | null {
  if (state.runtime && typeof state.runtime.getSetting === "function") {
    return resolveCanonicalOwnerId(
      state.runtime as Parameters<typeof resolveCanonicalOwnerId>[0],
    );
  }
  return null;
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
  // ── /api/notifications/push-policy (per-principal policy seam, #23106) ──
  if (pathname === PUSH_POLICY_PATH && (method === "GET" || method === "PUT")) {
    const policies = getPolicies(state);
    if (!policies) {
      helpers.error(res, "push delivery service not ready", 503);
      return true;
    }
    const principalId = resolvePolicyPrincipal(state);
    if (!principalId) {
      // Fail-closed distinct state: no canonical owner configured — the policy
      // seam cannot address a principal, so there is nothing to read/write.
      helpers.error(res, "no canonical recipient configured", 409);
      return true;
    }
    if (method === "GET") {
      const policy = await policies.load(principalId);
      helpers.json(res, { policy });
      return true;
    }
    const body = await helpers.readJsonBody<Record<string, unknown>>(req, res, {
      maxBytes: 8 * 1024,
    });
    if (body === null) return true;
    if (typeof body.pushEnabled !== "boolean") {
      helpers.error(res, "pushEnabled must be a boolean", 400);
      return true;
    }
    // Serialized per-principal load→bump→save (PushPolicyStore.update): two
    // concurrent PUTs for one principal cannot both observe version N and
    // both write N+1 — each update persists a distinct monotonic version, so
    // a concurrent opt-out is never silently overwritten.
    let next: PushDeliveryPolicy;
    try {
      next = await policies.update(principalId, body.pushEnabled);
    } catch (err) {
      // error-policy:J1 boundary translation — the HTTP boundary converts a
      // durable policy-write failure into a structured 503 (never a fabricated
      // success); the error itself is logged for diagnostics before the
      // translation.
      logger.error(
        { src: "api:push-policy", principalLength: principalId.length, err },
        "[push-policy] durable policy write failed",
      );
      helpers.error(res, "failed to persist push policy", 503);
      return true;
    }
    helpers.json(res, { policy: next });
    return true;
  }

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
    // #23106 recipient binding: an explicit ownerEntityId is accepted only
    // when it matches the canonical owner (a body-supplied id is not
    // authorization); absent → canonical owner; unresolvable → unowned token
    // (never pushed to). A present-but-malformed/mismatched id is a 400,
    // never a silent default to another principal.
    const principal = resolveRegistrationPrincipal(state, body.ownerEntityId);
    if (!principal.resolved && principal.reason === "invalid") {
      helpers.error(
        res,
        "ownerEntityId must be the canonical owner entity id",
        400,
      );
      return true;
    }
    const ownerEntityId = principal.resolved
      ? principal.principalId
      : undefined;
    // The registry re-validates the token (byte cap included). A typed
    // validation failure is a client error (400); a durable-write failure
    // propagates and the server boundary maps it to 500.
    try {
      await registry.register(platform, token, ownerEntityId);
    } catch (err) {
      // error-policy:J4 user-facing degrade — only the expected validation
      // shape becomes a 400; every other failure rethrows to the 500 boundary.
      if (isPushTokenValidationError(err)) {
        helpers.error(res, "invalid push token", 400);
        return true;
      }
      throw err;
    }
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
    return unregisterOrError(registry, token, res, helpers);
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
    return unregisterOrError(registry, token, res, helpers);
  }

  helpers.error(res, "push-token route not found", 404);
  return true;
}

/**
 * Run `registry.unregister`, applying the same byte-bound validation as the
 * register path across BOTH DELETE shapes. A typed validation failure maps to
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

// Re-exported for route consumers/tests that import the policy parser here.
export { parsePushDeliveryPolicy };
