// Egress health for the managed Eliza App message path.
//
// The gateway message POST to /api/internal/discord/eliza-app/messages is
// idempotent upstream (the onboarding worker keys turns on
// `discord:<messageId>` and the session coordinator orders them), so replaying
// the POST after a transient failure returns the identical reply instead of
// forking the session or double-provisioning. That makes bounded retry the
// correct response to the proven dropped-turn class: the staging E2E on
// 2026-08-05 showed the real bot silently dropping a user turn on a single
// 401 from the fail-closed internal-JWT denylist during a Redis flake.
//
// This module deliberately owns no transport state: callers pass a `doPost`
// closure (rebuilt per attempt so refreshed auth headers apply) and an
// optional `refreshAuth` hook invoked before retrying a 401.

export interface RoutedManagedReply {
  handled?: boolean;
  replyText?: string | null;
  replyCta?: { label?: string; url?: string } | null;
  reason?: string;
  agentId?: string;
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
      // Network error / timeout / missing token: transient by classification.
      lastStatus = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      options.onAttemptFailure?.({ attempt, error: lastError });
    }

    if (response) {
      if (response.ok) {
        const routed = (await response.json()) as RoutedManagedReply;
        return { ok: true, routed, attempts: attempt };
      }

      lastStatus = response.status;
      lastError = (await response.text().catch(() => "")).slice(0, 200);
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
      } catch {
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
