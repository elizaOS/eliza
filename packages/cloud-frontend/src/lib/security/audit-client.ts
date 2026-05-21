/**
 * Client-side audit emission. POSTs an event to the SOC2 audit endpoint
 * (`POST /api/v1/security/audit`) using the same allowlisted action names as
 * `@elizaos/security/audit`. The server endpoint is responsible for stamping
 * the actor's user id, ip, and user-agent before persisting via the canonical
 * `AuditDispatcher` — the client only carries action + result + metadata.
 *
 * The cloud-api side of this endpoint may not yet exist; consumers must call
 * `emitAuditEvent` inside a try/catch and degrade gracefully (UI work
 * continues, the event is dropped). We intentionally do not block UI flows on
 * audit delivery.
 */

import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * The exact action strings allowed by `@elizaos/security/audit`'s
 * `AUDIT_ACTIONS` tuple. Kept in sync by hand: if the server-side list grows,
 * add the new strings here. The server validates the action again, so a
 * mismatch results in a 4xx (handled by `emitAuditEvent` as graceful degrade).
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
 * Best-effort fire-and-forget. Returns true if delivery succeeded, false
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
    if (err instanceof ApiError && err.status === 404) {
      // Endpoint not yet wired in cloud-api. Surface in dev for visibility but
      // do not break user flows in prod.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          "[audit-client] /api/v1/security/audit not implemented; event dropped",
          input,
        );
      }
      return false;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[audit-client] emit failed", err, input);
    }
    return false;
  }
}
