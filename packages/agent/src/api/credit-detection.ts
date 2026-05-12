/**
 * Credit/quota exhaustion detection for provider errors.
 *
 * Matches error messages, HTTP status codes (402, 429 with billing context),
 * and structured error bodies from various AI providers.
 */

const INSUFFICIENT_CREDITS_RE =
  /\b(?:insufficient(?:[_\s]+(?:credits?|quota|funds))|insufficient_quota|out of credits|max usage reached|quota(?:\s+exceeded)?|rate_limit_exceeded|billing.*disabled|payment.*required|account.*suspended|spending.*limit|budget.*exceeded|no.*api.*credits|credit.*balance.*zero)\b/i;

const BILLING_KEYWORDS_RE =
  /\b(?:billing|quota|credits?|budget|spending|payment|subscription|plan limit)\b/i;

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

function getErrorMessage(err: unknown, fallback = "generation failed"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}
