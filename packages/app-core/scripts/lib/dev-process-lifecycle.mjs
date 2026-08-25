/**
 * Guards long-running development supervisors against orphaning and wedged API
 * children that remain alive while their health endpoint stops responding.
 */

/**
 * Watch the launcher PID that owns a development supervisor. A changed parent
 * means the shell, task runner, or desktop session that requested the dev stack
 * is gone, so the supervisor must drain its children instead of becoming a
 * permanent PID-1 orphan.
 */
export function createParentExitGuard({
  initialPpid,
  getPpid,
  onParentExit,
  intervalMs = 2_000,
  disabled = false,
}) {
  let timer = null;
  let fired = false;

  const check = () => {
    if (disabled || fired) return;
    const currentPpid = getPpid();
    if (currentPpid === initialPpid) return;
    fired = true;
    if (timer) clearInterval(timer);
    timer = null;
    onParentExit({ initialPpid, currentPpid });
  };

  return {
    start() {
      if (disabled || timer || initialPpid <= 1) return;
      timer = setInterval(check, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    checkNow: check,
  };
}

/** Probes remembered for restart evidence — covers the full failing streak. */
const PROBE_HISTORY_SIZE = 12;

/**
 * Restart a supervised API child only after repeated failed health probes.
 * Successful probes reset the streak so a transient busy event never bounces
 * the runtime, while a live-but-wedged TCP listener repairs itself.
 *
 * Policy, tuned from live incidents:
 *
 *   - The stall budget must absorb a heavy turn. A ~40s event-loop stall
 *     during a spawn-heavy TASKS turn was fatal under the old 3 × 5s policy
 *     (live 2026-08-24 06:40): the healthy child was recycled mid-turn and
 *     the killed turn surfaced as user silence. With `failureThreshold` 6 and
 *     a slow-probe caller timeout of ~10s, a wedged child is recycled after
 *     roughly 30-75s of continuous unresponsiveness while a 40-60s stall
 *     survives (probes overlap the interval; in-flight ticks are skipped).
 *   - Every child spawn gets a boot hold. A booting child is not "ready" for
 *     35-120s (the 2026-08-25 00:00 replacement spent 64s in module imports
 *     alone under midnight host contention; 2026-08-23 saw 98s). Callers arm
 *     the hold via `noteChildSpawn()` from the supervisor's onSpawn hook so
 *     crash respawns and hot reloads are covered, not just watchdog-initiated
 *     restarts (the old `recoveryGraceMs` covered only the latter, and its
 *     180s bound was exceeded on a thrashing box — live 2026-08-24 06:43, a
 *     child recycled while still loading plugins). While held, unhealthy
 *     probes are recorded but not counted until the first healthy probe,
 *     bounded by `bootGraceMs` so a child that never comes up still recycles.
 *   - After the first healthy probe post-spawn, `readyMarginMs` keeps the
 *     hold briefly: `ready:true` flips before the deferred boot tail
 *     (app routes, connector catalog, voice warmup) finishes, and that tail
 *     can monopolize the loop.
 *   - `restart(evidence)` receives the failing streak's probe records so the
 *     recycle log states WHY (latency + failure code per probe).
 */
export function createApiHealthWatchdog({
  check,
  restart,
  isShuttingDown = () => false,
  intervalMs = 5_000,
  failureThreshold = 6,
  bootGraceMs = 300_000,
  readyMarginMs = 30_000,
  now = Date.now,
}) {
  let timer = null;
  let failures = 0;
  let checkInFlight = false;
  /** Epoch ms until which unhealthy probes are boot/margin, not wedge; 0 = off. */
  let holdUntil = 0;
  /** True from child spawn until its first healthy probe. */
  let awaitingFirstHealthy = false;
  /** Epoch ms of the last healthy probe; 0 = none observed yet. */
  let lastHealthyAt = 0;
  /** @type {Array<{atMs: number, durationMs: number, healthy: boolean, detail: string}>} */
  let probeHistory = [];

  const recordProbe = (probe) => {
    probeHistory.push(probe);
    if (probeHistory.length > PROBE_HISTORY_SIZE) {
      probeHistory = probeHistory.slice(-PROBE_HISTORY_SIZE);
    }
  };

  const armBootHold = (atMs) => {
    awaitingFirstHealthy = true;
    holdUntil = atMs + bootGraceMs;
    failures = 0;
  };

  const checkNow = async () => {
    if (checkInFlight || isShuttingDown()) return;
    checkInFlight = true;
    const startedAt = now();
    let healthy = false;
    let detail = "unknown";
    try {
      const result = await check();
      if (typeof result === "object" && result !== null) {
        healthy = result.healthy === true;
        detail = typeof result.detail === "string" ? result.detail : "unknown";
      } else {
        healthy = result === true;
        detail = healthy ? "ok" : "unhealthy";
      }
    } catch (error) {
      healthy = false;
      detail =
        error instanceof Error ? error.message.slice(0, 120) : "check-threw";
    } finally {
      checkInFlight = false;
    }
    const finishedAt = now();
    recordProbe({
      atMs: startedAt,
      durationMs: finishedAt - startedAt,
      healthy,
      detail,
    });

    if (healthy) {
      failures = 0;
      lastHealthyAt = finishedAt;
      if (awaitingFirstHealthy) {
        awaitingFirstHealthy = false;
        holdUntil = finishedAt + readyMarginMs;
      } else if (finishedAt >= holdUntil) {
        holdUntil = 0;
      }
      return;
    }

    // Boot hold / post-ready margin: record, but don't count. Once the hold
    // expires a never-healthy child falls through and accrues failures, so
    // genuine wedge recovery survives.
    if (holdUntil > 0 && finishedAt < holdUntil) return;
    holdUntil = 0;
    failures += 1;
    if (failures < failureThreshold) return;

    const evidence = {
      failures,
      sinceLastHealthyMs: lastHealthyAt > 0 ? finishedAt - lastHealthyAt : null,
      probes: probeHistory.slice(),
    };
    // Defensive re-arm: the supervisor's onSpawn calls noteChildSpawn() when
    // the replacement actually starts, but the hold must exist even if that
    // wiring is absent, or the watchdog kills every replacement mid-boot.
    armBootHold(finishedAt);
    restart(evidence);
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void checkNow(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      failures = 0;
    },
    /**
     * Arm the boot hold for a freshly spawned child. Wire this to the API
     * supervisor's onSpawn hook so EVERY spawn path (initial launch, crash
     * respawn, hot reload, watchdog restart) gets its boot window.
     */
    noteChildSpawn() {
      armBootHold(now());
    },
    checkNow,
  };
}

/**
 * Renders a watchdog restart-evidence payload as a single log-line fragment:
 * per-probe timestamp (UTC HH:MM:SS), outcome detail, and latency. Pure so the
 * recycle-reason format is testable without a live supervisor.
 */
export function formatProbeEvidence(evidence) {
  const probes = Array.isArray(evidence?.probes) ? evidence.probes : [];
  if (probes.length === 0) return "no probe history";
  const lines = probes.map((probe) => {
    const at = new Date(probe.atMs).toISOString().slice(11, 19);
    const outcome = probe.healthy ? "ok" : `fail(${probe.detail})`;
    return `${at} ${outcome} ${Math.round(probe.durationMs)}ms`;
  });
  const sinceHealthy =
    typeof evidence?.sinceLastHealthyMs === "number"
      ? `last healthy ${Math.round(evidence.sinceLastHealthyMs / 1000)}s ago; `
      : "";
  return `${sinceHealthy}probes: ${lines.join(", ")}`;
}
