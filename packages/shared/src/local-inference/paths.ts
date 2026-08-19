/**
 * Path resolution for the local-inference service.
 *
 * All Eliza-owned files live under `<state-dir>/local-inference/` to match
 * the convention established by `plugin-installer.ts` and the rest of
 * app-core. We never write to paths outside of this root.
 *
 * `<state-dir>` follows the canonical `ELIZA_STATE_DIR` > XDG state
 * precedence;
 * on AOSP, `ELIZA_STATE_DIR` is set by `ElizaAgentService.java` to
 * `/data/data/<pkg>/files/.eliza` so models land at
 * `<that>/local-inference/models/` and not under a stray homedir-derived
 * path.
 */

import * as fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

function resolveRealPathSync(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // error-policy:J3 ancestor missing — walk up to longest existing parent
  }
  const tail: string[] = [];
  let current = absolute;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    try {
      return path.join(fs.realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

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
  // Lexical fast-path: cheap reject before touching the filesystem.
  if (!isWithin(resolved, root)) return false;
  // Physical check: a subdir symlink to /etc would lexically appear inside
  // but `fs.stat` follows the link, so we must also compare realpaths.
  try {
    const realRoot = resolveRealPathSync(root);
    const realTarget = resolveRealPathSync(resolved);
    return isWithin(realTarget, realRoot);
  } catch {
    // error-policy:J3 realpath failed — fall back to lexical result already computed
    return true;
  }
}
