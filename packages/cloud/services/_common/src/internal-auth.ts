import { timingSafeEqual } from "node:crypto";
import type { ServiceLogger } from "./logger";

/** Reject missing credentials; compare bytes and lengths without padding aliases. */
export function validateGatewayInternalSecret(
  request: Request,
  logger: Pick<ServiceLogger, "warn">,
  secret = process.env.GATEWAY_INTERNAL_SECRET ?? "",
): boolean {
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
