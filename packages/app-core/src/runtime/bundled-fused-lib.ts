/**
 * Locate + wire the fused `libelizainference` that ships INSIDE a packaged
 * desktop app, so a compiled app serves local inference with no env wiring and
 * no separate download.
 *
 * The desktop packaging (`packages/app-core/scripts/desktop-build.mjs` →
 * `stage-desktop-fused-lib.mjs`) stages the fused set into
 * `<eliza-dist>/local-inference/lib/`, and the Electrobun build copies the
 * whole `dist` tree to `Resources/app/eliza-dist/`. At runtime this module
 * lives at `<eliza-dist>/node_modules/@elizaos/app-core/dist/runtime/…`, so we
 * walk up looking for a `local-inference/lib/<fused>` that actually exists.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@elizaos/core";

/**
 * Candidate filenames for the fused library, per platform. Mirrors
 * `plugin-local-inference`'s `resolveFusedLibraryPath` / the FFI loader so the
 * probe and the runtime agree on what counts as "the fused lib is here".
 */
export function fusedLibraryFilenames(): string[] {
  if (process.platform === "darwin") return ["libelizainference.dylib"];
  if (process.platform === "win32")
    return ["elizainference.dll", "libelizainference.dll"];
  return ["libelizainference.so"];
}

/**
 * Walk up from `startUrl`'s directory looking for a `local-inference/lib`
 * directory that already contains a platform fused lib. Self-validating (only
 * matches where the artifact is), so there is no layout ambiguity. Returns null
 * in dev (run from source, nothing staged) and on mobile (native lib ships via
 * jniLibs / xcframework). Best-effort; never throws.
 */
export function findBundledFusedLibDir(
  startUrl: string = import.meta.url,
): string | null {
  try {
    const names = fusedLibraryFilenames();
    let dir = path.dirname(fileURLToPath(startUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, "local-inference", "lib");
      if (names.some((name) => existsSync(path.join(candidate, name)))) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta / fs probing must never break boot.
  }
  return null;
}

/**
 * Point the local-inference runtime at the app-bundled fused lib when one is
 * present. Respects an explicit operator override (`ELIZA_INFERENCE_LIBRARY` /
 * `ELIZA_INFERENCE_LIB_DIR`) and is a no-op when nothing is bundled (dev,
 * mobile) — `resolveFusedLibraryPath` then falls back to
 * `<stateDir>/local-inference/lib` as before. Idempotent. Returns the dir it
 * wired (or already-set override), else null.
 */
export function ensureBundledFusedLibDir(
  env: NodeJS.ProcessEnv = process.env,
  startUrl: string = import.meta.url,
): string | null {
  if (env.ELIZA_INFERENCE_LIBRARY?.trim()) {
    return path.dirname(env.ELIZA_INFERENCE_LIBRARY.trim());
  }
  if (env.ELIZA_INFERENCE_LIB_DIR?.trim()) {
    return env.ELIZA_INFERENCE_LIB_DIR.trim();
  }
  const bundled = findBundledFusedLibDir(startUrl);
  if (!bundled) return null;
  env.ELIZA_INFERENCE_LIB_DIR = bundled;
  logger.info(`[eliza] Using app-bundled local-inference lib dir: ${bundled}`);
  return bundled;
}
