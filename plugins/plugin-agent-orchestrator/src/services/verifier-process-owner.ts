/**
 * Resolves OS kernel and PID-namespace identity for durable verifier ownership.
 * Unprovable locality requires explicit operator review instead of recovery.
 */
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

type ProcessScope = { id: string } | { unavailableReason: string };
const execFileAsync = promisify(execFile);
let scope: Promise<ProcessScope> | undefined;

/** Kernel boot identity plus PID namespace, never a user-configurable hostname. */
export function getVerifierProcessScope(): Promise<ProcessScope> {
  scope ??= readScope();
  return scope;
}

async function readScope(): Promise<ProcessScope> {
  try {
    if (process.platform === "linux") {
      const [boot, namespace] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readlink("/proc/self/ns/pid"),
      ]);
      if (boot.trim() && namespace.trim()) {
        return { id: `linux:${boot.trim()}:${namespace.trim()}` };
      }
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "/usr/sbin/sysctl",
        ["-n", "kern.bootsessionuuid"],
        { timeout: 5000 },
      );
      if (stdout.trim()) return { id: `darwin:${stdout.trim()}` };
    }
    return {
      unavailableReason:
        "No supported kernel process-scope identity is available",
    };
  } catch (error) {
    // error-policy:J1 OS boundary: unavailable identity requires operator review,
    // never a hostname fallback or permission to reclaim another process's work.
    return {
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}
