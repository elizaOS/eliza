/**
 * Bounded supervisor shutdown drain for the dev host scripts.
 *
 * `dev-ui.mjs` used to SIGTERM its children and then SIGKILL every child
 * process tree on a fixed 1.5 s fuse, without ever awaiting a child `exit`
 * event. That fuse is shorter than the bounded teardown children are entitled
 * to perform: the Discord connector alone may spend up to 10 s draining
 * in-flight turns plus 2 s reconciling status reactions before its process
 * exits (`plugins/plugin-discord/shutdown-drain.ts`), so the drain that merged
 * in #17749 could never finish under the dev supervisor (elizaOS/eliza#16318).
 *
 * This module inverts that contract. Supervisor exit follows child exit
 * directly instead of a fixed schedule; only a child that outlives the window
 * is escalated to SIGKILL, per straggler and loudly, so a drain timeout is an
 * observable event instead of a silent kill.
 * The wait stays bounded end to end (window + kill grace): a child that
 * survives even SIGKILL delivery cannot wedge supervisor exit.
 */

/** Environment override for the drain window, in milliseconds. */
export const SHUTDOWN_DRAIN_WINDOW_ENV = "ELIZA_DEV_SHUTDOWN_DRAIN_MS";

/**
 * Default drain window. Covers the longest bounded child-side teardown the
 * repo currently ships (Discord: 10 s turn drain + 2 s reaction reconcile)
 * with margin for runtime teardown that runs before connector stop.
 */
export const DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS = 15_000;

/**
 * Bounded wait after SIGKILL escalation for the kill to be delivered and the
 * children reaped, so supervisor exit does not race the escalation it just
 * issued. This path is already the failure path; the wait must be tight.
 */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Resolve the drain window from the environment. Unset, empty, non-numeric,
 * and non-positive values all fall back to the default: a broken override
 * must degrade to the safe window, never to "kill immediately" or "wait
 * forever".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveShutdownDrainWindowMs(env = process.env) {
  const raw = env[SHUTDOWN_DRAIN_WINDOW_ENV];
  if (raw === undefined || raw === "") return DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS;
  }
  return Math.floor(value);
}

/**
 * A child is live when it exists and has not yet reported an exit. A child
 * that failed to spawn (`error` event, no pid) is treated as live and simply
 * never emits `exit`; the window bound covers it, and signaling it is a
 * no-op in the tree killer.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @returns {boolean}
 */
function isLive(child) {
  return Boolean(child) && child.exitCode == null && child.signalCode == null;
}

/**
 * @typedef {Object} DrainResult
 * @property {boolean} timedOut
 *   True when the drain window elapsed with children still running. This is
 *   the only sound "shutdown was not clean" signal; `killed` alone cannot
 *   distinguish a straggler that was reaped during the kill grace from one
 *   that never was.
 * @property {string[]} killed
 *   Names of children that were escalated to SIGKILL, in escalation order.
 */

/**
 * SIGTERM every live child, await their exits up to `drainWindowMs`, then
 * SIGKILL only the stragglers and wait a bounded grace for the kill to land.
 *
 * @param {Object} options
 * @param {{ name: string, child: import("node:child_process").ChildProcess | null }[]} options.children
 *   Named child handles. Null and already-exited entries are skipped.
 * @param {number} options.drainWindowMs
 * @param {(child: import("node:child_process").ChildProcess, signal: "SIGTERM" | "SIGKILL") => void} options.signalTree
 *   Tree-aware signal delivery (dev hosts pass `signalSpawnedProcessTree`).
 * @param {number} [options.killGraceMs]
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.warn]
 * @returns {Promise<DrainResult>}
 */
export function drainSpawnedChildren(options) {
  const {
    children,
    drainWindowMs,
    signalTree,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    log = console.log.bind(console),
    warn = console.error.bind(console),
  } = options;

  const live = children.filter((entry) => isLive(entry.child));
  for (const entry of live) {
    signalTree(entry.child, "SIGTERM");
  }
  if (live.length === 0) {
    return Promise.resolve({ timedOut: false, killed: [] });
  }
  log(
    `[eliza] Draining ${live.length} child process${
      live.length === 1 ? "" : "es"
    } (up to ${drainWindowMs} ms)…`,
  );

  return new Promise((resolve) => {
    const remaining = new Set(live);
    /** @type {string[]} */
    const killed = [];
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let graceTimer = null;

    // Deliberately ref'd: children hold the event loop open while they run,
    // and every path below ends in the caller's `process.exit`, so a ref'd
    // timer cannot outlive the process — but an unref'd one could fail to
    // fire if a child closed its stdio without exiting.
    const windowTimer = setTimeout(() => {
      for (const entry of remaining) {
        warn(
          `[eliza] ${entry.name} did not exit within ${drainWindowMs} ms — escalating to SIGKILL.`,
        );
        killed.push(entry.name);
        signalTree(entry.child, "SIGKILL");
      }
      graceTimer = setTimeout(() => finish(true), killGraceMs);
    }, drainWindowMs);

    /** @param {boolean} timedOut */
    function finish(timedOut) {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ timedOut, killed });
    }

    for (const entry of live) {
      entry.child.once("exit", () => {
        remaining.delete(entry);
        if (remaining.size === 0) finish(killed.length > 0);
      });
    }
  });
}
