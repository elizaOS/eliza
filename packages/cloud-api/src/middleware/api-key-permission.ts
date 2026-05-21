/**
 * Per-route middleware that enforces a specific permission scope on the
 * API key authenticating the request. Lives in its own file (separate from
 * `auth.ts`) so callers don't pull in the global auth-gate's transitive
 * dependencies just to enforce an API-key scope.
 *
 * No-op for session-authenticated (cookie / Steward JWT) requests — those
 * are governed by user role + org-membership checks instead.
 *
 * Permission match rules:
 *   - `*` (wildcard) on the key grants every permission.
 *   - Exact-string match.
 *   - Hierarchical prefix match: a key with `agents:*` grants `agents:write`.
 *
 * Denied requests return 403 and emit an `api_key.use` audit event with
 * `result: "denied"`.
 */

import type { MiddlewareHandler } from "hono";

import { ForbiddenError } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { getAuditDispatcher } from "../services/audit-dispatcher-singleton";

export function requireApiKeyPermission(
  permission: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authMethod = c.get("authMethod");
    if (authMethod !== "api_key") {
      await next();
      return;
    }

    const perms = c.get("apiKeyPermissions") ?? [];
    const granted = perms.some(
      (p) =>
        p === "*" ||
        p === permission ||
        (p.endsWith(":*") && permission.startsWith(p.slice(0, -1))),
    );

    if (granted) {
      await next();
      return;
    }

    const user = c.get("user");
    const apiKeyId = c.get("apiKeyId");
    try {
      await getAuditDispatcher().emit({
        actor: { type: "api_key", id: apiKeyId ?? "unknown" },
        action: "api_key.use",
        result: "denied",
        resource: { type: "permission", id: permission },
        org_id: user?.organization_id ?? undefined,
        ip:
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
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
  };
}
