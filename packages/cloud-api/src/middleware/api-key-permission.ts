/**
 * Per-route API-key permission scoping.
 *
 * `enforceApiKeyPermission(c, scope)` is the canonical check: it inspects the
 * auth context populated by `requireUserOrApiKeyWithOrg` (`authMethod`,
 * `apiKeyPermissions`) and throws `ForbiddenError` when an API key lacks the
 * required scope. Call it INSIDE a handler, immediately after auth resolves —
 * the auth context is only set once `requireUserOrApiKeyWithOrg` runs, so a
 * pre-handler middleware would see `authMethod === undefined` and silently
 * pass every request.
 *
 * `requireApiKeyPermission(scope)` is the Hono-middleware wrapper, used by
 * routes whose handlers reject API keys outright (session-only management
 * endpoints): the scope never matters for an API key because those handlers
 * call `requireUserWithOrg`, so a no-op-on-undefined middleware is correct
 * there. Do NOT use the middleware form on a route that accepts API keys.
 *
 * Session-authenticated (cookie / Steward JWT) requests are not scoped here —
 * they are governed by user role + org-membership checks instead.
 *
 * Permission match rules:
 *   - `*` (wildcard) on the key grants every permission.
 *   - Exact-string match.
 *   - Hierarchical prefix match: a key with `agents:*` grants `agents:write`.
 *
 * Denied requests emit an `api_key.use` audit event with `result: "denied"`.
 */

import type { MiddlewareHandler } from "hono";

import { ForbiddenError } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { getAuditDispatcher } from "../services/audit-dispatcher-singleton";

function isPermissionGranted(perms: string[], permission: string): boolean {
  return perms.some(
    (p) =>
      p === "*" ||
      p === permission ||
      (p.endsWith(":*") && permission.startsWith(p.slice(0, -1))),
  );
}

async function denyMissingPermission(
  c: AppContext,
  permission: string,
  perms: string[],
): Promise<never> {
  const user = c.get("user");
  const apiKeyId = c.get("apiKeyId");
  try {
    await getAuditDispatcher().emit({
      actor: { type: "api_key", id: apiKeyId ?? "unknown" },
      action: "api_key.use",
      result: "denied",
      resource: { type: "permission", id: permission },
      org_id: user?.organization_id ?? undefined,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
      user_agent: c.req.header("user-agent") ?? undefined,
      request_id: c.get("requestId"),
      metadata: {
        key_id: apiKeyId ?? "unknown",
        scopes: perms,
        reason: "missing_permission",
      },
    });
  } catch (err) {
    logger.warn("[requireApiKeyPermission] audit emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  throw ForbiddenError(`API key missing required permission: ${permission}`);
}

/**
 * Enforce an API-key scope from inside a handler, after auth has resolved.
 * No-op for session-authenticated requests.
 */
export async function enforceApiKeyPermission(
  c: AppContext,
  permission: string,
): Promise<void> {
  if (c.get("authMethod") !== "api_key") return;

  const perms = c.get("apiKeyPermissions") ?? [];
  if (isPermissionGranted(perms, permission)) return;

  await denyMissingPermission(c, permission, perms);
}

/**
 * Hono-middleware form for session-only management routes. See file header:
 * do not use this on a route that accepts API keys (it cannot see the key's
 * permissions because they are not resolved until the handler runs).
 */
export function requireApiKeyPermission(
  permission: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("authMethod") !== "api_key") {
      await next();
      return;
    }

    const perms = c.get("apiKeyPermissions") ?? [];
    if (isPermissionGranted(perms, permission)) {
      await next();
      return;
    }

    await denyMissingPermission(c, permission, perms);
  };
}
