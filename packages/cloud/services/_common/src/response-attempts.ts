/**
 * Observable bounded HTTP attempt policy shared by connector runtimes.
 * Callers own authentication and structured logging while this module owns
 * retry classification, Retry-After bounds, delay, and transport failure.
 */

export type ResponseRetryReason = "auth_refresh" | "status" | "transport";

export interface ResponseAttemptObservation {
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  response: Response | null;
  error: unknown;
  retryable: boolean;
  retryReason: ResponseRetryReason | null;
  retryAfterSeconds: number | null;
  retryDelayMs: number | null;
}

export interface ResponseAttemptsOptions {
  maxAttempts: number;
  request(): Promise<Response>;
  refreshAuth?(): Promise<void>;
  retryStatuses: boolean;
  retryTransport: boolean;
  retryDelayCapMs?: number;
  observe(observation: ResponseAttemptObservation): void | Promise<void>;
}

export interface ResponseAttemptsResult {
  response: Response;
  attempts: number;
  durationMs: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function executeResponseAttempts(
  options: ResponseAttemptsOptions,
): Promise<ResponseAttemptsResult> {
  const startedAt = performance.now();
  const delayCapMs = options.retryDelayCapMs ?? 5_000;
  let lastTransportError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const attemptStartedAt = performance.now();
    try {
      const response = await options.request();
      if (
        response.status === 401 &&
        options.refreshAuth &&
        attempt < options.maxAttempts
      ) {
        await options.observe({
          attempt,
          maxAttempts: options.maxAttempts,
          durationMs: Math.round(performance.now() - attemptStartedAt),
          response,
          error: null,
          retryable: true,
          retryReason: "auth_refresh",
          retryAfterSeconds: null,
          retryDelayMs: 0,
        });
        await response.body?.cancel();
        await options.refreshAuth();
        continue;
      }

      const retryable = isRetryableStatus(response.status);
      const shouldRetry =
        !response.ok &&
        retryable &&
        options.retryStatuses &&
        attempt < options.maxAttempts;
      const parsedRetryAfter = Number.parseInt(
        response.headers.get("Retry-After") ?? "",
        10,
      );
      const retryAfterSeconds = Number.isFinite(parsedRetryAfter)
        ? parsedRetryAfter
        : null;
      const retryDelayMs = shouldRetry
        ? retryAfterSeconds === null
          ? 200 * attempt
          : Math.min(Math.max(retryAfterSeconds, 0) * 1_000, delayCapMs)
        : null;
      await options.observe({
        attempt,
        maxAttempts: options.maxAttempts,
        durationMs: Math.round(performance.now() - attemptStartedAt),
        response,
        error: null,
        retryable,
        retryReason: shouldRetry ? "status" : null,
        retryAfterSeconds,
        retryDelayMs,
      });
      if (!shouldRetry || retryDelayMs === null) {
        return {
          response,
          attempts: attempt,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } catch (error) {
      lastTransportError = error;
      const shouldRetry =
        options.retryTransport && attempt < options.maxAttempts;
      const retryDelayMs = shouldRetry ? 200 * attempt : null;
      await options.observe({
        attempt,
        maxAttempts: options.maxAttempts,
        durationMs: Math.round(performance.now() - attemptStartedAt),
        response: null,
        error,
        retryable: shouldRetry,
        retryReason: shouldRetry ? "transport" : null,
        retryAfterSeconds: null,
        retryDelayMs,
      });
      if (!shouldRetry || retryDelayMs === null) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(
    `HTTP attempts ended without a response: ${lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError)}`,
    { cause: lastTransportError },
  );
}
