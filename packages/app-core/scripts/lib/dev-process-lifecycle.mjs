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

/**
 * Restart a supervised API child only after repeated failed health probes.
 * Successful probes reset the streak so a transient busy event never bounces
 * the runtime, while a live-but-wedged TCP listener repairs itself.
 */
export function createApiHealthWatchdog({
  check,
  restart,
  isShuttingDown = () => false,
  intervalMs = 5_000,
  failureThreshold = 3,
  // A replacement child is not "ready" for the whole of its boot (~35s on a
  // loaded box) — far longer than threshold × interval. Without a hold, the
  // watchdog that just restarted a wedged child killed every replacement
  // 15s into its boot, looping for 30+ restarts (live 2026-08-22). After a
  // restart, failures are not counted until the first healthy probe, bounded
  // by this grace so a replacement that never comes up is still restarted.
  recoveryGraceMs = 180_000,
  now = Date.now,
}) {
  let timer = null;
  let failures = 0;
  let checkInFlight = false;
  /** Epoch ms until which unhealthy probes are boot, not wedge; 0 = off. */
  let recoveringUntil = 0;

  const checkNow = async () => {
    if (checkInFlight || isShuttingDown()) return;
    checkInFlight = true;
    let healthy = false;
    try {
      healthy = (await check()) === true;
    } catch {
      healthy = false;
    } finally {
      checkInFlight = false;
    }
    if (healthy) {
      failures = 0;
      recoveringUntil = 0;
      return;
    }
    if (recoveringUntil > 0 && now() < recoveringUntil) return;
    recoveringUntil = 0;
    failures += 1;
    if (failures < failureThreshold) return;
    failures = 0;
    recoveringUntil = now() + recoveryGraceMs;
    restart();
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
    checkNow,
  };
}
