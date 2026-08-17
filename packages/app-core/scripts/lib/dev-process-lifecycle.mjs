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
}) {
  let timer = null;
  let failures = 0;
  let checkInFlight = false;

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
      return;
    }
    failures += 1;
    if (failures < failureThreshold) return;
    failures = 0;
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
