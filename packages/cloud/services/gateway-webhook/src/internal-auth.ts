/** Enforces internal-event and BFF-forwarder trust boundaries for gateway ingress. */
import { timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

/**
 * Validates the X-Internal-Secret header against the K8s-mounted secret
 * using constant-time comparison to prevent timing attacks.
 *
 * The secret is read from process.env on each call (same pattern as
 * AGENT_SERVER_SHARED_SECRET in tryTarget) so runtime config changes
 * are picked up without a restart.
 *
 * Returns false (and logs at warn level) when:
 * - GATEWAY_INTERNAL_SECRET env var is not configured
 * - Header is missing from the request
 * - Header value does not match the secret
 *
 * The constant-time comparison always runs, even when the secret or
 * header is empty, to prevent timing oracles from revealing whether
 * the env var is configured. Both buffers are padded to equal length
 * (minimum 1 byte) so timingSafeEqual never receives zero-length
 * inputs and always runs for the same duration.
 */
export function validateInternalSecret(request: Request): boolean {
  const secret = process.env.GATEWAY_INTERNAL_SECRET ?? "";
  const header = request.headers.get("X-Internal-Secret") ?? "";

  // Extract boolean flags before any buffer work so the constant-time
  // comparison always runs regardless of empty inputs.
  const secretMissing = !secret;
  const headerMissing = !header;

  // Logging here is intentional for operational visibility: operators need
  // to know why requests are being rejected. The timing oracle concern is
  // mitigated because timingSafeEqual always runs below (no early return).
  if (secretMissing) {
    logger.warn(
      "Internal auth rejected: GATEWAY_INTERNAL_SECRET not configured",
    );
  } else if (headerMissing) {
    logger.warn("Internal auth rejected: missing X-Internal-Secret header");
  }

  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  const maxLen = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);

  // Compare original lengths before using padded buffers so values like
  // "secret\0\0" can never match "secret" after padding.
  const lengthMatch = a.length === b.length;
  // Pre-compute both conditions so the || below does not short-circuit and
  // timingSafeEqual always executes regardless of length match.
  const valueMatch = timingSafeEqual(aPadded, bPadded);

  if (secretMissing || headerMissing || !lengthMatch || !valueMatch) {
    if (!secretMissing && !headerMissing) {
      logger.warn("Internal auth rejected: invalid secret");
    }
    return false;
  }

  return true;
}

/**
 * The dedicated header/secret the eliza-app BFF forwarder stamps on webhook
 * forwards (finding L3, #12878 / #12227). Deliberately SEPARATE from
 * `GATEWAY_INTERNAL_SECRET` / `X-Internal-Secret` (which gate `/internal/event`)
 * so enabling the BFF-forwarder gate does NOT force every direct provider
 * webhook to present the internal-event secret.
 */
export const FORWARDER_SECRET_HEADER = "X-Eliza-Webhook-Forwarder-Secret";

// The project the eliza-app BFF forwarder targets (matches the forwarder's
// `ELIZA_APP_WEBHOOK_PROJECT`, default "eliza-app"). The forwarder secret gate
// applies ONLY to this project, so other gateway tenants that post directly
// with valid provider auth are never affected.
export type ForwarderAuthReadiness =
  | "enforced"
  | "secret-disabled"
  | "project-mismatch";

function resolveForwarderAuth(project: string): {
  readiness: ForwarderAuthReadiness;
  secret: string;
} {
  const secret = (process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET ?? "").trim();
  const forwardedProject =
    (process.env.ELIZA_APP_WEBHOOK_PROJECT ?? "eliza-app").trim() ||
    "eliza-app";

  if (!secret) {
    return { readiness: "secret-disabled", secret };
  }
  if (project !== forwardedProject) {
    return { readiness: "project-mismatch", secret };
  }
  return { readiness: "enforced", secret };
}

/** Reports whether the dedicated forwarder gate applies to the named project. */
export function getForwarderAuthReadiness(
  project: string,
): ForwarderAuthReadiness {
  return resolveForwarderAuth(project).readiness;
}

/**
 * Optional BFF-forwarder gate for the public webhook routes (finding L3,
 * #12878 / #12227). The eliza-app BFF forwarder stamps
 * `X-Eliza-Webhook-Forwarder-Secret` (from `ELIZA_APP_WEBHOOK_GATEWAY_SECRET`)
 * on every forwarded webhook call. When that secret is configured the gateway
 * MUST reject any webhook request FOR THE FORWARDED PROJECT that does not carry
 * it — that is what makes the forwarder the only path to the gateway for that
 * project (defense-in-depth on top of the per-provider signature the adapters
 * verify).
 *
 * Scoped to `project`: only requests whose `:project` matches the BFF's
 * forwarded project (`ELIZA_APP_WEBHOOK_PROJECT`, default "eliza-app") are
 * gated. Other projects/tenants that post directly with valid provider auth are
 * never blocked.
 *
 * Backward-compatible by design: when `ELIZA_APP_WEBHOOK_GATEWAY_SECRET` is NOT
 * set the gate is a no-op (returns true), so existing deployments — including
 * ones that already use `GATEWAY_INTERNAL_SECRET` for internal events — keep
 * working unchanged. Setting the dedicated secret is the opt-in that turns on
 * fail-closed BFF-only enforcement for the forwarded project.
 *
 * The comparison is constant-time and always runs (even with empty inputs) to
 * avoid leaking, via timing, whether the secret is configured.
 *
 * @param request the incoming webhook request
 * @param project the `:project` path param of the webhook route
 * @returns true if the request may proceed, false if it must be rejected 401.
 */
export function enforceForwarderSecret(
  request: Request,
  project: string,
): boolean {
  // Resolve the same state used by the public auth-readiness contract. A
  // disabled secret or another project remains backward-compatible traffic;
  // only the configured forwarded project enters the constant-time gate.
  const { readiness, secret } = resolveForwarderAuth(project);
  if (readiness !== "enforced") {
    return true;
  }

  // The header is stamped by us (already trimmed), but trim defensively so a
  // proxy that re-adds whitespace can't cause a spurious mismatch.
  const header = (request.headers.get(FORWARDER_SECRET_HEADER) ?? "").trim();
  if (!header) {
    logger.warn(
      "Forwarder auth rejected: missing X-Eliza-Webhook-Forwarder-Secret header",
    );
  }

  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  const maxLen = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);

  const lengthMatch = a.length === b.length;
  const valueMatch = timingSafeEqual(aPadded, bPadded);

  if (!header || !lengthMatch || !valueMatch) {
    if (header) {
      logger.warn("Forwarder auth rejected: invalid secret");
    }
    return false;
  }

  return true;
}
