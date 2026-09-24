/**
 * Rapid-restart guard for the agent supervisor (`run-node.mjs`).
 *
 * When the agent requests a restart it exits with `RESTART_EXIT_CODE` (75) and
 * the supervisor relaunches it. A crash loop — where the child dies and
 * re-requests a restart immediately, forever — must not spin the host. This
 * guard records each restart and reports whether too many have happened inside a
 * sliding window, in which case the supervisor aborts instead of relaunching.
 *
 * Extracted from the inline supervisor logic so the window/trim/threshold math
 * is deterministic given an injected `now` and directly unit-testable.
 *
 * @module restart-guard
 */

/**
 * Register a restart at `now` and report whether the supervisor should abort.
 *
 * Mutates `timestamps` in place (the supervisor owns one long-lived array):
 * pushes `now`, drops every timestamp older than `windowMs`, then returns `true`
 * when the surviving count exceeds `maxInWindow`.
 *
 * @param {number[]} timestamps - Restart timestamps (ms), oldest first; mutated.
 * @param {number} now - Current time in epoch milliseconds.
 * @param {number} maxInWindow - Max restarts allowed within the window before aborting.
 * @param {number} windowMs - Sliding window length in milliseconds.
 * @returns {boolean} `true` → abort the restart loop; `false` → relaunch is allowed.
 */
export function registerRestartAndShouldAbort(
  timestamps,
  now,
  maxInWindow,
  windowMs,
) {
  timestamps.push(now);
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }
  return timestamps.length > maxInWindow;
}
