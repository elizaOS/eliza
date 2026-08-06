/**
 * Owns opt-in parent-death and child-process-group handling for run-node-tsx so
 * long-lived test stacks cannot survive an abruptly terminated runner.
 */

/** Parse the wrapper-only flag without consuming arguments intended for the child. */
export function parseRunNodeTsxArgs(argv) {
  if (argv[0] !== "--exit-with-parent") {
    return { childArgs: [...argv], exitWithParent: false };
  }
  return { childArgs: argv.slice(1), exitWithParent: true };
}

/** Signal a detached POSIX child group, falling back to the immediate child. */
export function signalChildProcessTree({
  child,
  killProcess = process.kill,
  platform = process.platform,
  signal,
}) {
  if (child.exitCode != null || child.signalCode != null) return false;
  if (platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      killProcess(-child.pid, signal);
      return true;
    } catch {
      // error-policy:J6 signaling is best-effort teardown; the immediate child
      // fallback below remains observable through its boolean return value.
      // A concurrently exiting group can disappear between the state check and
      // signal. Fall through to ChildProcess.kill for the remaining process.
    }
  }
  return child.kill(signal);
}

/**
 * Poll the wrapper's parent because Node has no portable parent-death signal.
 * PID 1/0 means the launcher died and the wrapper was reparented.
 */
export function startParentOrphanWatchdog({
  clearIntervalFn = clearInterval,
  intervalMs = 1_000,
  onOrphan,
  readParentPid = () => process.ppid,
  setIntervalFn = setInterval,
}) {
  let triggered = false;
  let timer;
  const stop = () => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };
  const check = () => {
    if (triggered || readParentPid() > 1) return false;
    triggered = true;
    stop();
    onOrphan();
    return true;
  };
  timer = setIntervalFn(check, intervalMs);
  timer.unref?.();
  return { check, stop };
}
