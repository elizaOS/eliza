/**
 * Error-formatting + classification utilities for global process handlers.
 *
 * Shared between the CLI (`run-main.ts`), the dev-server (`dev-server.ts`), the
 * agent serve path, and `installProcessCrashGuards` (`process-guards.ts`).
 * Intentionally dependency-free — only string/object inspection.
 */

import {
  formatDiagnosticError,
  readDiagnosticProperty,
} from "./utils/safe-diagnostic-error.js";

export function formatUncaughtError(error: unknown): string {
  return formatDiagnosticError(error);
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
    const isObject = current !== null && typeof current === "object";
    if (isObject) {
      if (seen.has(current)) continue;
      seen.add(current);
    }

    const formatted = formatUncaughtError(current);
    const isProviderError =
      /AI_NoOutputGeneratedError|No output generated|AI_APICallError|AI_RetryError/i.test(
        formatted,
      );
    if (isProviderError) {
      if (hasInsufficientCreditsSignal(formatted)) return true;

      const statusCode = readDiagnosticProperty(current, "statusCode");
      if (statusCode === 402) return true;

      const responseBody = readDiagnosticProperty(current, "responseBody");
      if (
        typeof responseBody === "string" &&
        hasInsufficientCreditsSignal(responseBody)
      ) {
        return true;
      }
    }

    if (!isObject) continue;

    const errors = readDiagnosticProperty(current, "errors");
    if (Array.isArray(errors)) {
      pending.push(...errors);
    }

    pending.push(readDiagnosticProperty(current, "cause"));
  }

  return false;
}
