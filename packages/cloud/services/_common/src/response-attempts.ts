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
  /**
   * Authentication refreshes that may add one request without consuming the
   * transport/status retry budget. This lets a stale token discovered after
   * transient failures still receive a fresh-credential attempt.
   */
  authRefreshAttemptsOutsideBudget?: number;
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
  const authRefreshAttemptsOutsideBudget = Math.max(
    0,
    Math.floor(options.authRefreshAttemptsOutsideBudget ?? 0),
  );
  const maxRequestAttempts =
    options.maxAttempts + authRefreshAttemptsOutsideBudget;
  let requestAttempt = 0;
  let budgetAttempts = 0;
  let outsideBudgetAuthRefreshes = 0;
  let lastTransportError: unknown;
  while (
    requestAttempt < maxRequestAttempts &&
    budgetAttempts < options.maxAttempts
  ) {
    requestAttempt += 1;
    const attemptStartedAt = performance.now();
    try {
      const response = await options.request();
      const canRefreshOutsideBudget =
        outsideBudgetAuthRefreshes < authRefreshAttemptsOutsideBudget;
      const canRefreshInsideBudget = budgetAttempts + 1 < options.maxAttempts;
      if (
        response.status === 401 &&
        options.refreshAuth &&
        (canRefreshOutsideBudget || canRefreshInsideBudget)
      ) {
        if (canRefreshOutsideBudget) outsideBudgetAuthRefreshes += 1;
        else budgetAttempts += 1;
        await options.observe({
          attempt: requestAttempt,
          maxAttempts: maxRequestAttempts,
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

      budgetAttempts += 1;
      const retryable = isRetryableStatus(response.status);
      const shouldRetry =
        !response.ok &&
        retryable &&
        options.retryStatuses &&
        budgetAttempts < options.maxAttempts;
      const parsedRetryAfter = Number.parseInt(
        response.headers.get("Retry-After") ?? "",
        10,
      );
      const retryAfterSeconds = Number.isFinite(parsedRetryAfter)
        ? parsedRetryAfter
        : null;
      const retryDelayMs = shouldRetry
        ? retryAfterSeconds === null
          ? 200 * budgetAttempts
          : Math.min(Math.max(retryAfterSeconds, 0) * 1_000, delayCapMs)
        : null;
      await options.observe({
        attempt: requestAttempt,
        maxAttempts: maxRequestAttempts,
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
          attempts: requestAttempt,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } catch (error) {
      lastTransportError = error;
      budgetAttempts += 1;
      const shouldRetry =
        options.retryTransport && budgetAttempts < options.maxAttempts;
      const retryDelayMs = shouldRetry ? 200 * budgetAttempts : null;
      await options.observe({
        attempt: requestAttempt,
        maxAttempts: maxRequestAttempts,
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
