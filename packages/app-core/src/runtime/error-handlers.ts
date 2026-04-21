/**
 * Shared error-formatting utilities for global process handlers.
 * Used by both the CLI (run-main.ts) and the dev-server (dev-server.ts).
 * Intentionally dependency-free — only string operations.
 */

export function formatUncaughtError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function hasInsufficientCreditsSignal(input: string): boolean {
  return /\b(insufficient(?:[_\s]+(?:credits?|quota))|insufficient_quota|out of credits|payment required|statuscode:\s*402)\b/i.test(
    input,
  );
}

/**
 * Returns `true` when the rejection looks like an AI provider credit-exhaustion
 * error — these are noisy but not fatal, so callers should warn instead of crash.
 */
export function shouldIgnoreUnhandledRejection(reason: unknown): boolean {
  const formatted = formatUncaughtError(reason);
  if (
    !/AI_NoOutputGeneratedError|No output generated|AI_APICallError/i.test(
      formatted,
    )
  ) {
    return false;
  }

  if (hasInsufficientCreditsSignal(formatted)) {
    return true;
  }

  if (reason && typeof reason === "object") {
    const statusCode = (reason as { statusCode?: number }).statusCode;
    if (statusCode === 402) return true;

    const responseBody = (reason as { responseBody?: unknown }).responseBody;
    if (
      typeof responseBody === "string" &&
      hasInsufficientCreditsSignal(responseBody)
    ) {
      return true;
    }
  }

  return false;
}
