import { timingSafeEqual } from "crypto";
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
    logger.warn("Internal auth rejected: GATEWAY_INTERNAL_SECRET not configured");
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
