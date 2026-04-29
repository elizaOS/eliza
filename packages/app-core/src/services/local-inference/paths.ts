/**
 * Path resolution for the local-inference service.
 *
 * All Milady-owned files live under `$STATE_DIR/local-inference/` to match
 * the convention established by `plugin-installer.ts` and the rest of
 * app-core. We never write to paths outside of this root.
 *
 * The state dir is resolved in `MILADY_STATE_DIR` → `ELIZA_STATE_DIR` →
 * `~/.eliza` order. The `.eliza` fallback is preserved for desktop
 * backward-compat with existing installs; on AOSP `MILADY_STATE_DIR` is
 * set by `MiladyAgentService.java` to `/data/data/<pkg>/files/.milady`,
 * so models land at `<that>/local-inference/models/` and not under a
 * stray homedir-derived path.
 */

import os from "node:os";
import path from "node:path";

export function localInferenceRoot(): string {
  const stateDir =
    process.env.MILADY_STATE_DIR?.trim() || process.env.ELIZA_STATE_DIR?.trim();
  const base = stateDir || path.join(os.homedir(), ".eliza");
  return path.join(base, "local-inference");
}

/** Directory for models Milady downloaded itself. Safe to delete. */
export function miladyModelsDir(): string {
  return path.join(localInferenceRoot(), "models");
}

/** JSON file tracking installed-model metadata (downloaded + discovered). */
export function registryPath(): string {
  return path.join(localInferenceRoot(), "registry.json");
}

/** Partial-download staging directory; files here are resume candidates. */
export function downloadsStagingDir(): string {
  return path.join(localInferenceRoot(), "downloads");
}

/** True when `target` is inside Milady's local-inference root. */
export function isWithinMiladyRoot(target: string): boolean {
  const root = path.resolve(localInferenceRoot());
  const resolved = path.resolve(target);
  if (resolved === root) return false;
  return resolved.startsWith(`${root}${path.sep}`);
}
