/**
 * Org-membership guard for routes that accept user-supplied resource IDs.
 *
 * Implicit `organization_id` filtering at the repository layer hides IDOR
 * attempts (the resource just appears "not found"). This helper makes the
 * check explicit, emits an `access.denied`-style audit event on cross-org
 * access, and lets handlers surface a precise 403 instead of a 404.
 *
 * NOTE: `AUDIT_ACTIONS` does not currently include a generic `access.denied`
 * action. We map cross-org access on a resource to the closest existing
 * action by resource kind (e.g. `secret.access`, `agent.config.update`,
 * `api_key.use`). If the resource kind is unknown we fall back to
 * `admin.action` with `result: "denied"`.
 */

import type { AuditAction } from "@elizaos/security/audit";
import type { Context } from "hono";
import { ForbiddenError } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { getAuditDispatcher } from "../services/audit-dispatcher-singleton";

export interface ActorContext {
  id: string;
  organization_id: string;
}

const RESOURCE_TYPE_TO_ACTION: Record<string, AuditAction> = {
  api_key: "api_key.use",
  agent: "agent.config.update",
  container: "agent.config.update",
  secret: "secret.access",
  workflow: "agent.config.update",
};

function clientIp(c: Context<AppEnv>): string | undefined {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined
  );
}

function userAgent(c: Context<AppEnv>): string | undefined {
  return c.req.header("user-agent") ?? undefined;
}

export interface OrgMembershipOptions {
  resourceType: string;
  resourceId: string;
  c: Context<AppEnv>;
}

/**
 * Throw 403 if `actor.organization_id !== resourceOrgId`. Emits an audit
 * `*.denied` event with the actor + resource on the global dispatcher.
 *
 * Returns void on success — handlers continue with the validated resource.
 */
export async function assertOrgMembership(
  actor: ActorContext,
  resourceOrgId: string | null | undefined,
  opts: OrgMembershipOptions,
): Promise<void> {
  if (resourceOrgId && actor.organization_id === resourceOrgId) return;

  const action: AuditAction =
    RESOURCE_TYPE_TO_ACTION[opts.resourceType] ?? "admin.action";

  try {
    await getAuditDispatcher().emit({
      actor: { type: "user", id: actor.id },
      action,
      result: "denied",
      resource: { type: opts.resourceType, id: opts.resourceId },
      org_id: actor.organization_id,
      ip: clientIp(opts.c),
      user_agent: userAgent(opts.c),
      request_id: opts.c.get("requestId"),
      metadata: { reason: "cross_org_access" },
    });
  } catch (err) {
    // Audit must never break the request path — log and continue with 403.
    logger.warn("[assertOrgMembership] audit emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  throw ForbiddenError("Resource not accessible to this organization");
}
