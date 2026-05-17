/**
 * API process supervisor with crash-loop backoff.
 *
 * Both `dev-ui.mjs` and `dev-platform.mjs` need to keep the API server alive
 * across `process.exit(0)` (RESTART action), `process.exit(75)` (CLI runner
 * restart exit code), and `bun --watch` reloads — but stop trying when the
 * server keeps exiting in a tight window (a real crash that needs a human).
 *
 * The supervisor is unaware of how the API is spawned; callers pass a
 * `spawnChild()` factory that returns a node ChildProcess. The factory is
 * called once per launch, including relaunches.
 *
 * Defaults:
 *   - 10s rolling window
 *   - 5 restarts permitted in that window before giving up
 *   - 400ms delay between exit and relaunch
 */

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_LIMIT = 5;
const DEFAULT_RESPAWN_DELAY_MS = 400;

/**
 * @typedef {Object} ApiSupervisorOptions
 * @property {() => import("node:child_process").ChildProcess} spawnChild
 *   Spawn a fresh API child. Called on `start()` and on every relaunch.
 * @property {(child: import("node:child_process").ChildProcess) => void} [onSpawn]
 *   Optional callback after each spawn (e.g. push child into a tracking array,
 *   wire log prefixers).
 * @property {(child: import("node:child_process").ChildProcess) => void} [onExit]
 *   Optional callback before backoff/relaunch decision (e.g. remove child
 *   from a tracking array, clear handle).
 * @property {(code: number | null, streak: number) => void} onGiveUp
 *   Called when the streak exceeds `limit` in `windowMs`. Caller should
 *   trigger shutdown.
 * @property {() => boolean} isShuttingDown
 *   Returns true while the parent process is in shutdown. Suppresses relaunch.
 * @property {(message: string) => void} [log] Defaults to `console.log`.
 * @property {(message: string) => void} [warn] Defaults to `console.error`.
 * @property {number} [windowMs] Default 10_000.
 * @property {number} [limit] Default 5.
 * @property {number} [respawnDelayMs] Default 400.
 */

/**
 * @param {ApiSupervisorOptions} opts
 */
export function createApiSupervisor(opts) {
  const {
    spawnChild,
    onSpawn,
    onExit,
    onGiveUp,
    isShuttingDown,
    log = console.log.bind(console),
    warn = console.error.bind(console),
    windowMs = DEFAULT_WINDOW_MS,
    limit = DEFAULT_LIMIT,
    respawnDelayMs = DEFAULT_RESPAWN_DELAY_MS,
  } = opts;

  let streak = 0;
  let lastExitAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingRespawn = null;

  function launch() {
    const child = spawnChild();
    if (onSpawn) onSpawn(child);
    child.on("exit", (code) => {
      if (onExit) onExit(child);
      if (isShuttingDown()) return;

      const now = Date.now();
      streak = now - lastExitAt < windowMs ? streak + 1 : 1;
      lastExitAt = now;

      if (streak > limit) {
        warn(
          `API exited with code ${code} ${streak} times in ${
            windowMs / 1000
          }s — giving up. Fix the underlying issue and restart the dev process.`,
        );
        onGiveUp(code, streak);
        return;
      }

      // The agent's RESTART action and `/api/restart` both bounce the server
      // with `process.exit(0)`; the CLI runner uses 75 as the dedicated
      // restart exit code; Bun's `--watch` reload also exits cleanly. Treat
      // any non-shutdown exit as "please restart me" and re-spawn.
      log(
        `API exited with code ${code} — relaunching (attempt ${streak}/${limit})…`,
      );
      pendingRespawn = setTimeout(() => {
        pendingRespawn = null;
        if (!isShuttingDown()) launch();
      }, respawnDelayMs);
    });
    return child;
  }

  return {
    start() {
      return launch();
    },
    /** Cancel any pending relaunch (e.g. during shutdown). */
    cancelPendingRespawn() {
      if (pendingRespawn) {
        clearTimeout(pendingRespawn);
        pendingRespawn = null;
      }
    },
  };
}
