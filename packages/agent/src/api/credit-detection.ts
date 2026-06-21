/**
 * Credit/quota exhaustion detection for provider errors.
 *
 * Matches error messages, HTTP status codes (402, 429 with billing context),
 * and structured error bodies from various AI providers.
 */

import { getErrorMessage } from "./server-helpers.ts";

const INSUFFICIENT_CREDITS_RE =
  /\b(?:insufficient(?:[_\s]+(?:credits?|quota|funds))|insufficient_quota|out of credits|max usage reached|quota(?:\s+exceeded)?|rate_limit_exceeded|billing.*disabled|payment.*required|account.*suspended|spending.*limit|budget.*exceeded|no.*api.*credits|credit.*balance.*zero)\b/i;

const BILLING_KEYWORDS_RE =
  /\b(?:billing|quota|credits?|budget|spending|payment|subscription|plan limit)\b/i;

const RATE_LIMIT_RE =
  /\b(?:rate[_\s-]?limit(?:ed|ing)?|too many requests|requests? per (?:minute|second|hour)|slow down)\b/i;

/**
 * A transient provider rate-limit (HTTP 429, or a rate-limit message) that is
 * NOT billing/credit exhaustion. Callers MUST check
 * {@link isInsufficientCreditsError} first — a 429 *with* billing context is
 * credit exhaustion ("top up"), whereas a bare 429 is "try again in a moment".
 */
export function isRateLimitError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "string") return RATE_LIMIT_RE.test(err);
  if (typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  if (status === 429) return true;
  const msg = getErrorMessage(err, "");
  const safe = msg.length > 10_000 ? msg.slice(0, 10_000) : msg;
  return RATE_LIMIT_RE.test(safe);
}

export function isInsufficientCreditsMessage(message: string): boolean {
  const safe = message.length > 10_000 ? message.slice(0, 10_000) : message;
  return INSUFFICIENT_CREDITS_RE.test(safe);
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
  const safeMsg = msg.length > 10_000 ? msg.slice(0, 10_000) : msg;
  if (status === 429 && BILLING_KEYWORDS_RE.test(safeMsg)) return true;

  const errorBody = (err as { error?: { type?: string; code?: string } }).error;
  if (errorBody?.type === "insufficient_quota") return true;
  if (typeof errorBody?.code === "string") {
    const safeCode =
      errorBody.code.length > 10_000
        ? errorBody.code.slice(0, 10_000)
        : errorBody.code;
    if (INSUFFICIENT_CREDITS_RE.test(safeCode)) {
      return true;
    }
  }

  return false;
}
