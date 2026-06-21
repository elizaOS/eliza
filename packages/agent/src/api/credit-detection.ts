/**
 * Credit/quota exhaustion detection for provider errors.
 *
 * Matches error messages, HTTP status codes (402, 429 with billing context),
 * and structured error bodies from various AI providers.
 *
 * Rate-limit detection lives in `@elizaos/core` (`isRateLimitError`, which adds
 * a structural 429 check over the AI-SDK error envelope); it is re-exported here
 * so callers keep one import surface. Callers MUST check
 * {@link isInsufficientCreditsError} first — a 429 *with* billing context is
 * credit exhaustion ("top up"), whereas a bare 429 is "try again in a moment".
 */

import { getErrorMessage } from "./server-helpers.ts";

export { isRateLimitError } from "@elizaos/core";

const INSUFFICIENT_CREDITS_RE =
  /\b(?:insufficient(?:[_\s]+(?:credits?|quota|funds))|insufficient_quota|out of credits|max usage reached|quota(?:\s+exceeded)?|rate_limit_exceeded|billing.*disabled|payment.*required|account.*suspended|spending.*limit|budget.*exceeded|no.*api.*credits|credit.*balance.*zero)\b/i;

const BILLING_KEYWORDS_RE =
  /\b(?:billing|quota|credits?|budget|spending|payment|subscription|plan limit)\b/i;

/** Cap a value before running a regex scan so a pathological provider payload
 *  cannot turn a substring match into a catastrophic-backtracking DoS. */
function clampForScan(value: string): string {
  return value.length > 10_000 ? value.slice(0, 10_000) : value;
}

export function isInsufficientCreditsMessage(message: string): boolean {
  return INSUFFICIENT_CREDITS_RE.test(clampForScan(message));
}

export function isInsufficientCreditsError(err: unknown): boolean {
  if (err == null || typeof err !== "object") {
    if (typeof err === "string") return isInsufficientCreditsMessage(err);
    return false;
  }

  const msg = getErrorMessage(err, "");
  if (isInsufficientCreditsMessage(msg)) return true;

  const status = (err as { status?: number }).status;
  if (status === 402) return true;
  if (status === 429 && BILLING_KEYWORDS_RE.test(clampForScan(msg)))
    return true;

  const errorBody = (err as { error?: { type?: string; code?: string } }).error;
  if (errorBody?.type === "insufficient_quota") return true;
  if (typeof errorBody?.code === "string") {
    if (INSUFFICIENT_CREDITS_RE.test(clampForScan(errorBody.code))) {
      return true;
    }
  }

  return false;
}
