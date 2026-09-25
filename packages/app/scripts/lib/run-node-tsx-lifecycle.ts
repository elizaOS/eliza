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
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (platform !== "win32") {
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
 * A different parent (including a subreaper) means the original launcher died.
 */
export function startParentOrphanWatchdog({
  clearIntervalFn = clearInterval,
  intervalMs = 1_000,
  onOrphan,
  readParentPid = () => process.ppid,
  setIntervalFn = setInterval,
}) {
  const initialParentPid = readParentPid();
  let triggered = false;
  let timer;
  const stop = () => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };
  const check = () => {
    const parentPid = readParentPid();
    if (triggered || (parentPid > 1 && parentPid === initialParentPid))
      return false;
    triggered = true;
    stop();
    onOrphan();
    return true;
  };
  timer = setIntervalFn(check, intervalMs);
  timer.unref?.();
  return { check, stop };
}
