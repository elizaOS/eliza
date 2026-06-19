/**
 * API process supervisor with crash-loop backoff.
 *
 * Both `dev-ui.mjs` and `dev-platform.mjs` need to keep the API server alive
 * across `process.exit(0)` (RESTART action), `process.exit(75)` (CLI runner
 * restart exit code), and intentional reloads — but stop trying when the server
 * keeps exiting in a tight window (a real crash that needs a human).
 *
 * The supervisor is unaware of how the API is spawned; callers pass a
 * `spawnChild()` factory that returns a node ChildProcess. The factory is
 * called once per launch, including relaunches.
 *
 * `restart()` lets a source watcher bounce the running child for a hot reload:
 * the kill it triggers is classified as intentional, so it relaunches
 * immediately and never counts toward the crash streak.
 *
 * Defaults:
 *   - 10s rolling window
 *   - 5 restarts permitted in that window before giving up
 *   - 400ms delay between exit and relaunch
 */

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_LIMIT = 5;
const DEFAULT_RESPAWN_DELAY_MS = 400;
const DEFAULT_KILL_ESCALATE_MS = 4_000;

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
 * @property {(child: import("node:child_process").ChildProcess, signal: "SIGTERM" | "SIGKILL") => void} [terminate]
 *   How to kill a child for an intentional `restart()`. Defaults to
 *   `child.kill(signal)`; callers that spawn process trees pass a tree-killer.
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
    terminate = (child, signal) => {
      try {
        child.kill(signal);
      } catch {
        // child already gone — nothing to signal.
      }
    },
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
  /** @type {import("node:child_process").ChildProcess | null} */
  let currentChild = null;
  /** When true, the next exit is a hot reload, not a crash. */
  let intentionalRestart = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let killEscalation = null;

  function clearKillEscalation() {
    if (killEscalation) {
      clearTimeout(killEscalation);
      killEscalation = null;
    }
  }

  function scheduleRelaunch() {
    pendingRespawn = setTimeout(() => {
      pendingRespawn = null;
      if (!isShuttingDown()) launch();
    }, respawnDelayMs);
  }

  function launch() {
    const child = spawnChild();
    currentChild = child;
    if (onSpawn) onSpawn(child);
    child.on("exit", (code) => {
      if (onExit) onExit(child);
      if (child === currentChild) currentChild = null;
      clearKillEscalation();
      if (isShuttingDown()) return;

      // Intentional hot reload (a source change). Relaunch promptly without
      // touching the crash streak — this is expected, not a failure.
      if (intentionalRestart) {
        intentionalRestart = false;
        scheduleRelaunch();
        return;
      }

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
      // restart exit code. Treat any non-shutdown exit as "please restart me".
      log(
        `API exited with code ${code} — relaunching (attempt ${streak}/${limit})…`,
      );
      scheduleRelaunch();
    });
    return child;
  }

  return {
    start() {
      return launch();
    },
    /**
     * Bounce the running API child for a hot reload. No-op during shutdown.
     * Safe to call repeatedly (e.g. from a debounced watcher) — overlapping
     * calls collapse onto the one in-flight kill.
     */
    restart() {
      if (isShuttingDown()) return;
      const child = currentChild;
      if (!child) {
        // Already between processes — a relaunch is queued (or will be). Make
        // sure one is actually pending so a restart() in the gap isn't lost.
        if (!pendingRespawn) launch();
        return;
      }
      // An intentional reload is not a crash — reset the streak so a burst of
      // edits can never trip the crash-loop give-up.
      streak = 0;
      if (intentionalRestart) return; // a kill is already in flight
      intentionalRestart = true;
      terminate(child, "SIGTERM");
      killEscalation = setTimeout(() => {
        killEscalation = null;
        if (currentChild === child) terminate(child, "SIGKILL");
      }, DEFAULT_KILL_ESCALATE_MS);
      killEscalation.unref?.();
    },
    /** Cancel any pending relaunch / kill escalation (e.g. during shutdown). */
    cancelPendingRespawn() {
      if (pendingRespawn) {
        clearTimeout(pendingRespawn);
        pendingRespawn = null;
      }
      clearKillEscalation();
    },
  };
}
