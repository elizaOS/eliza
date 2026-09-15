/**
 * Observable bounded HTTP attempt policy shared by connector runtimes.
 * Callers own authentication and structured logging while this module owns
 * retry classification, Retry-After bounds, delay, and transport failure.
 */

import { readPersonalSharedFailureMetadata } from "./personal-shared-failure";
import { computeBackoffMs, parseRetryAfterMs, sleepWithAbort } from "./retry";

export type ResponseRetryReason = "auth_refresh" | "status" | "transport";
export type ResponseReplayPolicy = "safe" | "idempotent" | "never";

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
  /** Named caller policy proving whether the request may be sent again. */
  replayPolicy: ResponseReplayPolicy;
  request(): Promise<Response>;
  refreshAuth?(): Promise<void>;
  retryStatuses: boolean;
  retryTransport: boolean;
  /** Statuses that must return immediately even when the default policy retries them. */
  nonRetriableStatuses?: readonly number[];
  /** Honor a sanitized upstream `X-Eliza-Retryable` disposition. */
  honorExplicitRetryable?: boolean;
  retryDelayCapMs?: number;
  baseDelayMs?: number;
  signal?: AbortSignal | null;
  nowMs?(): number;
  random?(): number;
  sleep?(delayMs: number, signal?: AbortSignal | null): Promise<void>;
  observe(observation: ResponseAttemptObservation): void | Promise<void>;
  /** Reports diagnostic observer failures without replaying a completed request. */
  reportObservationError(
    error: unknown,
    observation: ResponseAttemptObservation,
  ): void | Promise<void>;
}

export interface ResponseAttemptsResult {
  response: Response;
  attempts: number;
  durationMs: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function observeAttempt(
  options: ResponseAttemptsOptions,
  observation: ResponseAttemptObservation,
): Promise<void> {
  try {
    await options.observe(observation);
  } catch (error) {
    // error-policy:J7 attempt diagnostics must not replay or kill delivery.
    try {
      await options.reportObservationError(error, observation);
    } catch {
      // error-policy:J7 the reporter is the terminal diagnostics boundary; its own failure cannot kill delivery.
      return;
    }
  }
}

export async function executeResponseAttempts(
  options: ResponseAttemptsOptions,
): Promise<ResponseAttemptsResult> {
  const startedAt = performance.now();
  const delayCapMs = options.retryDelayCapMs ?? 5_000;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const authRefreshAttemptsOutsideBudget = Math.max(
    0,
    Math.floor(options.authRefreshAttemptsOutsideBudget ?? 0),
  );
  const maxRequestAttempts =
    options.maxAttempts + authRefreshAttemptsOutsideBudget;
  const mayReplay = options.replayPolicy !== "never";
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
    let response: Response;
    try {
      response = await options.request();
    } catch (error) {
      lastTransportError = error;
      budgetAttempts += 1;
      const shouldRetry =
        mayReplay &&
        options.retryTransport &&
        budgetAttempts < options.maxAttempts;
      const retryDelayMs = shouldRetry
        ? computeBackoffMs({
            attempt: budgetAttempts - 1,
            baseDelayMs,
            capMs: delayCapMs,
            retryAfter: null,
            nowMs: nowMs(),
            random: options.random,
          })
        : null;
      await observeAttempt(options, {
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
      await sleep(retryDelayMs, options.signal);
      continue;
    }

    const canRefreshOutsideBudget =
      outsideBudgetAuthRefreshes < authRefreshAttemptsOutsideBudget;
    const canRefreshInsideBudget = budgetAttempts + 1 < options.maxAttempts;
    if (
      response.status === 401 &&
      options.refreshAuth &&
      mayReplay &&
      (canRefreshOutsideBudget || canRefreshInsideBudget)
    ) {
      if (canRefreshOutsideBudget) outsideBudgetAuthRefreshes += 1;
      else budgetAttempts += 1;
      await response.body?.cancel();
      await observeAttempt(options, {
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
      await options.refreshAuth();
      continue;
    }

    budgetAttempts += 1;
    const failure = readPersonalSharedFailureMetadata(response);
    const retryable =
      !options.nonRetriableStatuses?.includes(response.status) &&
      (options.honorExplicitRetryable
        ? failure.retryable
        : isRetryableStatus(response.status));
    const shouldRetry =
      !response.ok &&
      retryable &&
      options.retryStatuses &&
      mayReplay &&
      budgetAttempts < options.maxAttempts;
    const retryAfterMs = parseRetryAfterMs(
      response.headers.get("Retry-After"),
      { nowMs: nowMs(), capMs: delayCapMs },
    );
    const retryAfterSeconds = options.honorExplicitRetryable
      ? failure.retryAfterSeconds
      : retryAfterMs === null
        ? null
        : retryAfterMs / 1_000;
    const retryDelayMs = shouldRetry
      ? computeBackoffMs({
          attempt: budgetAttempts - 1,
          baseDelayMs,
          capMs: delayCapMs,
          retryAfter: response.headers.get("Retry-After"),
          nowMs: nowMs(),
          random: options.random,
        })
      : null;
    if (shouldRetry) await response.body?.cancel();
    await observeAttempt(options, {
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
    await sleep(retryDelayMs, options.signal);
  }
  if (lastTransportError !== undefined) {
    throw new Error(
      `HTTP attempts ended without a response: ${lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError)}`,
      { cause: lastTransportError },
    );
  }
  throw new Error("HTTP attempts ended without a response");
}
