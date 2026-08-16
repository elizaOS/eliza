/**
 * Error-formatting + classification utilities for global process handlers.
 *
 * Shared between the CLI (`run-main.ts`), the dev-server (`dev-server.ts`), the
 * agent serve path, and `installProcessCrashGuards` (`process-guards.ts`).
 * Intentionally dependency-free — only string/object inspection.
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
  const seen = new Set<unknown>();
  const pending: unknown[] = [reason];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    const formatted = formatUncaughtError(current);
    const isProviderError =
      /AI_NoOutputGeneratedError|No output generated|AI_APICallError|AI_RetryError/i.test(
        formatted,
      );
    if (isProviderError) {
      if (hasInsufficientCreditsSignal(formatted)) return true;

      const statusCode = (current as { statusCode?: number }).statusCode;
      if (statusCode === 402) return true;

      const responseBody = (current as { responseBody?: unknown }).responseBody;
      if (
        typeof responseBody === "string" &&
        hasInsufficientCreditsSignal(responseBody)
      ) {
        return true;
      }
    }

    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      pending.push(...errors);
    }

    pending.push((current as { cause?: unknown }).cause);
  }

  return false;
}
