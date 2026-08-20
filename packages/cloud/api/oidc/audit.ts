/**
 * Audit emission for the OpenID Provider routes.
 *
 * Not a `route.ts`, so the router codegen skips it (it only mounts `route.ts` /
 * `route.tsx` leaves).
 *
 * Metadata is limited to what the dispatcher's `"oidc."` allowlist accepts —
 * `client_id`, `reason`, `scope`, `error`, plus the ip/ua it adds itself. An
 * authorization `code`, a `state`, a token, and a client secret must never
 * reach an audit sink, so none of them are passed here in the first place
 * rather than relying on the allowlist to strip them.
 *
 * Every emit is best-effort: an audit write must never turn a working sign-in
 * into a failed one.
 */

import { getRequestIp } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";
import { getAuditDispatcher } from "../src/services/audit-dispatcher-singleton";

type OidcAuditAction =
  | "oidc.authorize"
  | "oidc.authorize.denied"
  | "oidc.token";

export interface OidcAuditInput {
  action: OidcAuditAction;
  result: "success" | "failure";
  /** Omit when the request never resolved to an account. */
  userId?: string;
  orgId?: string;
  metadata?: Record<string, string>;
}

export async function emitOidcAudit(
  c: AppContext,
  input: OidcAuditInput,
): Promise<void> {
  await getAuditDispatcher()
    .emit({
      actor: { type: "user", id: input.userId ?? "anonymous" },
      action: input.action,
      result: input.result,
      resource: null,
      org_id: input.orgId,
      ip: getRequestIp(c),
      user_agent: c.req.header("user-agent") ?? undefined,
      request_id: c.get("requestId"),
      metadata: input.metadata,
    })
    // error-policy:J7 diagnostics must not kill the flow — a dropped audit is
    // logged; it never fails an authorization or a token exchange.
    .catch((error) =>
      logger.error("[oidc] audit emit failed", {
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}
