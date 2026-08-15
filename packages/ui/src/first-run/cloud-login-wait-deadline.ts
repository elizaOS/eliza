/**
 * Bounded wait for the first-run cloud sign-in popup (elizaOS/eliza#19255).
 *
 * The cloud login flow opens a popup and awaits a login session that may
 * never settle: a callback failure dead-ends cross-origin (raw JSON on the
 * auth domain), and an abandoned popup just sits there. Nothing rejects, so
 * the opener's catch never fires and the "Waiting for sign-in…" turn is an
 * indefinite hang with no recovery action.
 *
 * `armCloudLoginWaitDeadline` gives that wait a deadline; on expiry the
 * conductor converts the wait into the existing retry turn. Deliberately an
 * escape hatch, not a cancellation: the underlying login session is left
 * untouched, and a sign-in completed after abandonment is picked up by the
 * conductor's existing auto-resume path, so a slow-but-successful sign-in is
 * never lost. `createAttemptGuard` provides the stale-attempt check that
 * keeps a deadline-abandoned flow from mutating state the user has already
 * moved past — the same settled-wave rule the deferred plugin registration
 * watchdog documents.
 */

/**
 * Popup sign-ins normally finish well under a minute; account creation can
 * take longer, which the auto-resume path covers even after abandonment.
 * Ninety seconds bounds the visible hang without racing legitimate flows.
 */
export const CLOUD_LOGIN_WAIT_DEADLINE_MS = 90_000;

export interface CloudLoginDeadlineHandle {
  /** Cancel the deadline (the flow settled first). Idempotent. */
  cancel(): void;
}

export function armCloudLoginWaitDeadline(options: {
  onDeadline: () => void;
  deadlineMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): CloudLoginDeadlineHandle {
  const {
    onDeadline,
    deadlineMs = CLOUD_LOGIN_WAIT_DEADLINE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeoutFn(() => {
    timer = null;
    fired = true;
    onDeadline();
  }, deadlineMs);
  return {
    cancel() {
      if (fired || timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
    },
  };
}

export interface AttemptGuard {
  /** Start a new attempt; prior attempt ids become stale. */
  begin(): number;
  /** True while `id` is the newest attempt. */
  isCurrent(id: number): boolean;
  /** Invalidate the current attempt (deadline abandoned it). */
  invalidate(): void;
}

/**
 * Generation counter for one-at-a-time async flows: outcomes of an attempt
 * the user has abandoned (deadline) or superseded (retry) must become no-ops
 * rather than mutate the conversation out from under the newer state.
 */
export function createAttemptGuard(): AttemptGuard {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(id: number) {
      return id === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
