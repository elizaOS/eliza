/**
 * Backoff loop for automatic recovery from a terminal startup error. The
 * coordinator's error phase used to stop probing permanently after a fixed
 * attempt budget, which wedged the app in `phase=error` even after the backend
 * later became healthy (e.g. the user completed Cloud sign-in minutes later) —
 * downstream consumers like the boot-recovery conductor then read false
 * trouble from a working app. The loop now decays to the capped delay and
 * keeps probing at that slow cadence indefinitely (a 30s poll, not a probe
 * storm), and a Cloud sign-in (`steward-token-sync`) resets the backoff so the
 * very next probe runs at the fast delay.
 */

export interface StartupRecoveryPolicy {
  recoveryBaseDelayMs: number;
  recoveryMaxDelayMs: number;
  /** Attempts before the delay pins at `recoveryMaxDelayMs` (not a stop cap). */
  recoveryMaxAttempts: number;
}

export interface StartupRecoveryLoopOptions {
  /** Probe once; resolve true when startup recovered (the loop then stops). */
  probe: () => Promise<boolean>;
  policy: StartupRecoveryPolicy;
  /** Injectable timers for tests. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface StartupRecoveryLoop {
  start: () => void;
  stop: () => void;
  /** A sign-in just landed — reset backoff so the next probe is fast. */
  notifySignIn: () => void;
  /** The delay the next scheduled probe will use (exposed for tests). */
  nextDelayMs: () => number;
}

export function createStartupRecoveryLoop(
  options: StartupRecoveryLoopOptions,
): StartupRecoveryLoop {
  const { probe, policy } = options;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((id: number) => window.clearTimeout(id));

  let attempt = 0;
  let timer: number | null = null;
  let inFlight = false;
  let stopped = false;

  const delayFor = (a: number): number =>
    Math.min(policy.recoveryBaseDelayMs * 2 ** a, policy.recoveryMaxDelayMs);

  const schedule = () => {
    if (stopped || timer !== null || inFlight) return;
    const delay = delayFor(attempt);
    // Pin instead of stopping: a degraded backend keeps a slow heartbeat, so a
    // late recovery (sign-in, backend restart) is always eventually observed.
    attempt = Math.min(attempt + 1, policy.recoveryMaxAttempts);
    timer = setTimer(() => {
      timer = null;
      inFlight = true;
      void probe()
        .then((recovered) => {
          inFlight = false;
          if (!recovered) schedule();
        })
        .catch(() => {
          // error-policy:J4 the terminal startup error stays visible while the
          // loop retries; the caller logs probe failures with diagnostics.
          inFlight = false;
          schedule();
        });
    }, delay);
  };

  return {
    start: () => {
      stopped = false;
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    notifySignIn: () => {
      if (stopped) return;
      attempt = 0;
      if (timer !== null) {
        // Replace the pending slow probe with an immediate fast one.
        clearTimer(timer);
        timer = null;
      }
      schedule();
    },
    nextDelayMs: () => delayFor(attempt),
  };
}
