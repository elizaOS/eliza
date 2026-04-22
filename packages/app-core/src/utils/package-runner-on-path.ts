/**
 * Detect `npx` / `bunx` on PATH so we can fail fast (or fall back) with
 * accurate install hints instead of always blaming Bun.
 */

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

/** Default launcher for the local n8n sidecar (Node-backed n8n). */
export const N8N_DEFAULT_PACKAGE_LAUNCHER = "npx";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Human-readable install hint for a launcher basename (`npx`, `bunx`, …).
 */
export function formatPackageRunnerInstallHint(binary: string): string {
  const base = path.basename(binary.replaceAll("\\", "/"));
  if (base === "bunx") {
    return "Install Bun from https://bun.sh/ — `bunx` ships with Bun and must be on PATH.";
  }
  if (base === "npx") {
    return "Install Node.js (LTS) from https://nodejs.org/ — npm bundles `npx`, which must be on PATH.";
  }
  return "Install Node.js for `npx` (https://nodejs.org/) or Bun for `bunx` (https://bun.sh/), and ensure the launcher is on PATH.";
}

/**
 * Returns true if `binary --version` exits 0 within {@link PROBE_TIMEOUT_MS}.
 */
export async function probePackageRunnerOnPath(
  binary: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const proc = nodeSpawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* no-op */
      }
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
