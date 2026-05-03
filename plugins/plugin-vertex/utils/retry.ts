import { logger } from "@elizaos/core";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit")) return true;
    if (msg.includes("503") || msg.includes("overloaded")) return true;
    if (msg.includes("500") || msg.includes("internal")) return true;
    if (msg.includes("timeout") || msg.includes("econnreset")) return true;
  }
  return false;
}

export async function executeWithRetry<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES && isRetryable(error)) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          `[Vertex] ${operation} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw formatModelError(operation, error);
    }
  }
  throw formatModelError(operation, lastError);
}

export function formatModelError(operation: string, error: unknown): Error {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("401") || msg.includes("403"))
      return new Error(
        `[Vertex] ${operation}: authentication failed. Check GOOGLE_APPLICATION_CREDENTIALS or gcloud auth.`,
      );
    if (msg.includes("429"))
      return new Error(
        `[Vertex] ${operation}: rate limited. Try again in a few seconds.`,
      );
    if (msg.includes("404"))
      return new Error(
        `[Vertex] ${operation}: model not found. Check model name and region.`,
      );
    return new Error(`[Vertex] ${operation}: ${msg}`);
  }
  return new Error(`[Vertex] ${operation}: ${String(error)}`);
}
