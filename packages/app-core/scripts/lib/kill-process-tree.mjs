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
 * Signal the dedicated Unix process group created by `spawn(..., { detached:
 * true })`. Unlike a parent/child walk, this still reaches launcher descendants
 * after their immediate parent exits and they are reparented. Desktop dev uses
 * one dedicated group per service, so the negative PID target is exact.
 *
 * Falls back to the normal tree walk on Windows and when the child is not a
 * process-group leader.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalSpawnedProcessGroup(child, signal) {
  const pid = child?.pid;
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // ESRCH means this child was not the leader of a live dedicated group.
    }
  }
  signalProcessTree(pid, signal);
}

/**
 * Whether a detached child's dedicated Unix process group still has members.
 * This detects GUI launcher descendants even after the tracked CLI parent has
 * exited, which ChildProcess.exitCode alone cannot do.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @returns {boolean}
 */
export function isSpawnedProcessGroupAlive(child) {
  const pid = child?.pid;
  if (!Number.isFinite(pid) || pid <= 0 || process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
