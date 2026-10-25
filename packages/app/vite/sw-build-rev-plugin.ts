/**
 * Vite plugin: stamp a per-deploy build revision into the emitted service worker.
 *
 * THE PROBLEM (CONVERSATIONS-500-2026-07-22 fix #1): `packages/app/public/sw.js`
 * is copied VERBATIM into `dist/` by Vite (publicDir is not transformed). Its
 * cache names were hardcoded string literals, so a normal deploy produced a
 * `dist/sw.js` that was BYTE-IDENTICAL to the installed worker. The browser's SW
 * update check byte-diffs the fetched `/sw.js` against the installed one, finds
 * no change, and never installs a new worker — so install/skipWaiting/activate
 * (drop-stale-caches + clients.claim + navigate-windows) NEVER re-run on deploy.
 * All the update machinery in sw.js was dead code, and users had to manually
 * clear site data / reinstall the PWA to pick up a new renderer (the recurring
 * "clear-data ritual").
 *
 * THE FIX: replace the `__SW_BUILD_REV__` sentinel in the emitted `dist/sw.js`
 * with the git sha (or a build timestamp fallback) of THIS build. Any byte change
 * to sw.js makes the browser detect a new worker → the existing
 * install/activate flow runs automatically → the new renderer loads without a
 * clear-data ritual. sw.js also derives its cache-name suffixes from the rev, so
 * `activate` purges the prior deploy's caches.
 *
 * Runs in `closeBundle` (after publicDir is copied into dist) so it rewrites the
 * final on-disk `dist/sw.js`. Build-only (`apply: "build"`); dev never installs
 * the SW (registration is PROD-gated). Idempotent + non-fatal: if `dist/sw.js`
 * is absent (a secondary single-file build) it no-ops.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const SW_BUILD_REV_TOKEN = "__SW_BUILD_REV__";

/**
 * A stable, deploy-unique revision string: prefer an explicit env sha (CI sets
 * GIT_COMMIT/GIT_SHA), then `git rev-parse HEAD`, else a build timestamp so the
 * token is ALWAYS replaced with something byte-unique per build even outside a
 * git checkout.
 */
export function resolveSwBuildRev(): string {
  const envCommit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) return envCommit.slice(0, 12);
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    /* not a git checkout — fall through to a timestamp */
  }
  // Timestamp fallback: always byte-unique per build.
  return `t${Date.now().toString(36)}`;
}

export function swBuildRevPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "sw-build-rev",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      if (!existsSync(swPath)) return; // non-app build (no public sw.js emitted)
      try {
        const source = readFileSync(swPath, "utf8");
        if (!source.includes(SW_BUILD_REV_TOKEN)) {
          // Already stamped or a sw.js without the sentinel — nothing to do.
          return;
        }
        const rev = resolveSwBuildRev();
        // Replace ALL occurrences so the marker + any derived usage are stamped.
        const stamped = source.split(SW_BUILD_REV_TOKEN).join(rev);
        writeFileSync(swPath, stamped, "utf8");
        this.info?.(`[sw-build-rev] stamped dist/sw.js build rev=${rev}`);
      } catch (err) {
        // Non-fatal: a failed stamp means the SW keeps the sentinel (stable
        // "dev" suffix) — the app still works, it just won't auto-update on this
        // build. Surface as a warning so CI can notice, but never fail the build.
        const message = err instanceof Error ? err.message : String(err);
        this.warn?.(`[sw-build-rev] failed to stamp dist/sw.js: ${message}`);
      }
    },
  };
}
