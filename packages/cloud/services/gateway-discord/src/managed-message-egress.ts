/**
 * Provides bounded, idempotent retries for managed Discord message egress.
 * The upstream onboarding worker orders turns by Discord message ID, while
 * callers supply fresh POST and authentication closures for every attempt.
 */

export interface RoutedManagedReply {
  handled?: boolean;
  replyText?: string | null;
  replyCta?: { label?: string; url?: string } | null;
  reason?: string;
  agentId?: string;
}

function isRoutedManagedReply(value: unknown): value is RoutedManagedReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  return (
    (reply.handled === undefined || typeof reply.handled === "boolean") &&
    (reply.replyText === undefined ||
      reply.replyText === null ||
      typeof reply.replyText === "string") &&
    (reply.replyCta === undefined ||
      reply.replyCta === null ||
      (typeof reply.replyCta === "object" && !Array.isArray(reply.replyCta))) &&
    (reply.reason === undefined || typeof reply.reason === "string") &&
    (reply.agentId === undefined || typeof reply.agentId === "string")
  );
}

export type ManagedRouteOutcome =
  | { ok: true; routed: RoutedManagedReply; attempts: number }
  | {
      ok: false;
      attempts: number;
      /** HTTP status of the final failed attempt, absent for network errors. */
      status?: number;
      error: string;
    };

/**
 * 401 is retryable HERE (and only here) because the internal-JWT denylist is
 * fail-closed: a Redis read error rejects an otherwise valid token by design,
 * so adjacent-second retries with the same or a refreshed token succeed.
 * 408/429/5xx are the ordinary transient classes.
 */
export function isRetryableRouteStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the inbound Discord turn to the cloud routing API with bounded retry.
 *
 * Never silently consumes a turn: every attempt failure is reported to
 * `onAttemptFailure` for loud logging, and the final outcome distinguishes
 * routed success from exhausted retries so the caller can log the drop
 * explicitly instead of returning early.
 */
export async function postManagedAgentMessageWithRetry(options: {
  /** Performs one POST attempt. Rebuilt per call so refreshed auth applies. */
  doPost: () => Promise<Response>;
  /** Called before retrying a 401 so the caller can refresh its token. */
  refreshAuth?: () => Promise<void>;
  /** Loud per-attempt failure reporting (status or thrown error). */
  onAttemptFailure?: (info: {
    attempt: number;
    status?: number;
    error: string;
  }) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ManagedRouteOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastStatus: number | undefined;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | null = null;
    try {
      response = await options.doPost();
    } catch (error) {
      // error-policy:J4 Transient transport failures become an observable,
      // bounded retry outcome instead of consuming the user's turn silently.
      // Network error / timeout / missing token: transient by classification.
      lastStatus = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      options.onAttemptFailure?.({ attempt, error: lastError });
    }

    if (response) {
      if (response.ok) {
        try {
          const routed: unknown = await response.json();
          if (!isRoutedManagedReply(routed)) {
            throw new TypeError(
              "managed route returned an invalid reply object",
            );
          }
          return { ok: true, routed, attempts: attempt };
        } catch (error) {
          // error-policy:J4 A malformed success response is not delivered as a
          // healthy reply; expose it and retry the idempotent upstream turn.
          lastStatus = undefined;
          const parseError =
            error instanceof Error ? error.message : String(error);
          lastError = `invalid managed route response: ${parseError}`;
          options.onAttemptFailure?.({ attempt, error: lastError });
          response = null;
        }
      }

      if (response) {
        lastStatus = response.status;
      }
    }

    if (response) {
      try {
        const responseBody = (await response.text()).trim();
        lastError =
          responseBody.slice(0, 200) ||
          response.statusText.trim() ||
          `HTTP ${response.status}`;
      } catch (error) {
        // error-policy:J4 The HTTP status remains authoritative when its
        // optional diagnostic body cannot be read; expose that read failure.
        const readError =
          error instanceof Error ? error.message : String(error);
        lastError = `HTTP ${response.status}: unable to read error body (${readError})`;
      }
      options.onAttemptFailure?.({
        attempt,
        status: lastStatus,
        error: lastError,
      });

      if (!isRetryableRouteStatus(response.status)) {
        // Deterministic client errors (400/403/404) never heal on replay.
        return {
          ok: false,
          attempts: attempt,
          status: lastStatus,
          error: lastError,
        };
      }
    }

    if (attempt === maxAttempts) break;

    if (lastStatus === 401 && options.refreshAuth) {
      try {
        await options.refreshAuth();
      } catch (error) {
        // error-policy:J4 A failed refresh is reported through the attempt
        // observer while the bounded same-token retry remains available.
        const refreshError =
          error instanceof Error ? error.message : String(error);
        options.onAttemptFailure?.({
          attempt,
          status: lastStatus,
          error: `auth refresh failed: ${refreshError}`,
        });
        // A failed refresh is not fatal to the retry loop: the denylist
        // flake heals with the SAME token, and the next attempt reports
        // its own failure if auth is truly broken.
      }
    }

    // Exponential backoff with jitter keeps adjacent flaky turns decorrelated.
    const delay =
      baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
    await sleep(delay);
  }

  return {
    ok: false,
    attempts: maxAttempts,
    status: lastStatus,
    error: lastError,
  };
}

/**
 * Retry a Discord reply send on transient failures only.
 *
 * A routed reply that fails to send is a consumed turn from the user's view,
 * so transient send failures (network, Discord 5xx) get bounded retries.
 * Deterministic rejections (missing permission, cannot-DM, malformed payload:
 * Discord 4xx) fail immediately because replaying them cannot succeed.
 */
export async function sendReplyWithRetry(
  send: () => Promise<unknown>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onAttemptFailure?: (info: { attempt: number; error: string }) => void;
  } = {},
): Promise<{ sent: boolean; attempts: number; error?: string }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;

  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await send();
      return { sent: true, attempts: attempt };
    } catch (error) {
      // error-policy:J4 Discord delivery failures become a bounded, explicit
      // send result so callers can log the unavailable reply path.
      lastError = error instanceof Error ? error.message : String(error);
      options.onAttemptFailure?.({ attempt, error: lastError });

      const status = (error as { status?: unknown })?.status;
      const isDeterministic =
        typeof status === "number" && status >= 400 && status < 500;
      if (isDeterministic || attempt === maxAttempts) {
        return { sent: false, attempts: attempt, error: lastError };
      }
    }

    const delay =
      baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
    await sleep(delay);
  }

  return { sent: false, attempts: maxAttempts, error: lastError };
}
