/**
 * Signal only the process tree rooted at a known PID (from ChildProcess.pid).
 *
 * Unix: walks descendants via `pgrep -P <ppid>` — only processes whose parent chain
 * leads to that PID. Does **not** match by name; unrelated `bun` processes are never touched.
 *
 * Windows: `taskkill /PID <pid> /T` — same tree semantics for that PID only.
 */
import { execSync } from "node:child_process";

/**
 * @param {number} pid
 * @returns {number[]}
 */
function listChildPids(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null || true`, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return out
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
function signalProcessTreeUnix(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const sig = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
  for (const cpid of listChildPids(pid)) {
    signalProcessTreeUnix(cpid, signal);
  }
  try {
    process.kill(pid, sig);
  } catch {
    /* ESRCH */
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
function signalProcessTreeWin32(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const force = signal === "SIGKILL" ? "/F" : "";
  try {
    execSync(`taskkill /PID ${pid} /T ${force}`.trim(), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    /* already exited or access denied */
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalProcessTree(pid, signal) {
  if (process.platform === "win32") {
    signalProcessTreeWin32(pid, signal);
  } else {
    signalProcessTreeUnix(pid, signal);
  }
}

/**
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalSpawnedProcessTree(child, signal) {
  const pid = child?.pid;
  if (pid === undefined || pid === null) return;
  signalProcessTree(pid, signal);
}

/**
 * Signal a child that was spawned with `detached: true` as one Unix process
 * group. Unlike a parent/child walk, the group remains addressable after its
 * launcher exits and reparents the packaged app to PID 1.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalSpawnedProcessGroup(child, signal) {
  const pid = child?.pid;
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    signalProcessTreeWin32(pid, signal);
    return;
  }
  const sig = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, sig);
  } catch (error) {
    // error-policy:J6 Group teardown is best-effort. Only a still-live
    // non-detached child may use the exact-tree fallback; after leader exit an
    // ESRCH must not target a newly reused positive PID.
    if (
      !(error instanceof Error && Reflect.get(error, "code") === "ESRCH") ||
      child.exitCode != null ||
      child.signalCode != null
    ) {
      return;
    }
    // A caller may hand us a non-detached child. Preserve the established
    // exact-tree fallback without ever matching processes by name.
    signalProcessTreeUnix(pid, sig);
  }
}

/**
 * Report whether the detached Unix process group led by `child.pid` still has
 * members. The launcher may already be reaped while a native descendant keeps
 * the group alive, so `ChildProcess.exitCode` alone is not sufficient.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @returns {boolean}
 */
export function isSpawnedProcessGroupAlive(child) {
  const pid = child?.pid;
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    return child.exitCode == null && child.signalCode == null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // error-policy:J6 EPERM proves the group exists but is not signalable. An
    // ESRCH while the child itself is live identifies a non-detached child.
    const code = error instanceof Error ? Reflect.get(error, "code") : null;
    if (code === "EPERM") return true;
    if (code === "ESRCH") {
      return child.exitCode == null && child.signalCode == null;
    }
    // Unknown OS errors must not fabricate a clean shutdown.
    return true;
  }
}
