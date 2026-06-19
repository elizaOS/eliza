/**
 * Client-side audit emission. POSTs an event to the SOC2 audit endpoint
 * (`POST /api/v1/security/audit`) using the same allowlisted action names as
 * `@elizaos/security/audit`. The server stamps the actor id, ip, and user-agent
 * before persisting via the canonical `AuditDispatcher`; the client only carries
 * action + result + metadata.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/security/audit-client.ts`. The
 * cloud-api side of this endpoint may not exist yet, so callers degrade
 * gracefully: this helper never throws and returns `false` when delivery fails.
 */

import { ApiError, apiFetch } from "../../lib/api-client";

/**
 * The exact action strings allowed by `@elizaos/security/audit`'s
 * `AUDIT_ACTIONS` tuple. The server validates the action again, so a mismatch
 * results in a 4xx (handled here as a graceful degrade).
 */
export type ClientAuditAction =
  | "plugin.install"
  | "plugin.uninstall"
  | "plugin.grant"
  | "plugin.revoke"
  | "plugin.denied"
  | "vision.allowed"
  | "vision.denied"
  | "data.export"
  | "data.delete_request"
  | "auth.session.revoke"
  | "api_key.revoke";

export type AuditResult = "allow" | "deny" | "error";

export interface ClientAuditInput {
  action: ClientAuditAction;
  result: AuditResult;
  resource?: { type: string; id: string } | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Best-effort fire-and-forget. Returns `true` if delivery succeeded, `false`
 * otherwise. Never throws — callers must not depend on it for correctness.
 */
export async function emitAuditEvent(
  input: ClientAuditInput,
): Promise<boolean> {
  try {
    await apiFetch("/api/v1/security/audit", {
      method: "POST",
      json: {
        action: input.action,
        result: input.result,
        resource: input.resource ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
    return true;
  } catch (err) {
    // Endpoint unavailable (404) or any transient failure: drop the event. Audit
    // delivery must never block a user flow.
    if (err instanceof ApiError) return false;
    return false;
  }
}
