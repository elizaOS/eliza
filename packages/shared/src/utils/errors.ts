/**
 * Shared error classification helpers.
 *
 * Consolidates the timeout detection pattern that was independently
 * implemented in cloud-routes.ts and cloud-connection.ts.
 */

/** Classify an error as a fetch/AbortSignal timeout. */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const msg = error.message.toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout");
}

/** Classify a fetch Response as a redirect (3xx). */
export function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/** Extract a human-readable message from an unknown caught value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
