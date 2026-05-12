/**
 * Path resolution for the local-inference service.
 *
 * All Eliza-owned files live under `<state-dir>/local-inference/` to match
 * the convention established by `plugin-installer.ts` and the rest of
 * app-core. We never write to paths outside of this root.
 *
 * `<state-dir>` follows the canonical `ELIZA_STATE_DIR` >
<<<<<<< HEAD
 * `ELIZA_STATE_DIR` > `~/.${ELIZA_NAMESPACE ?? "eliza"}` precedence;
=======
 * `~/.${ELIZA_NAMESPACE ?? "eliza"}` precedence;
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
 * on AOSP, `ELIZA_STATE_DIR` is set by `ElizaAgentService.java` to
 * `/data/data/<pkg>/files/.eliza` so models land at
 * `<that>/local-inference/models/` and not under a stray homedir-derived
 * path.
 */

import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

export function localInferenceRoot(): string {
  return path.join(resolveStateDir(), "local-inference");
}

/** Directory for models Eliza downloaded itself. Safe to delete. */
export function elizaModelsDir(): string {
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

/** True when `target` is inside Eliza's local-inference root. */
export function isWithinElizaRoot(target: string): boolean {
  const root = path.resolve(localInferenceRoot());
  const resolved = path.resolve(target);
  if (resolved === root) return false;
  return resolved.startsWith(`${root}${path.sep}`);
}
