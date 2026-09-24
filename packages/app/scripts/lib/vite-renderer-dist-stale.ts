/**
 * Returns true when the main app needs a production `vite build`.
 *
 * Uses the renderer manifest for build-time variants and the build START time
 * vs. source mtimes. Output mtimes cannot detect edits made during compilation.
 * **Why not always build:** A full Vite production compile is expensive; skipping when dist
 * is fresh makes `dev:desktop` restarts fast. **Why mtime:** Good enough for local dev; use
 * `--force-renderer` / `ELIZA_DESKTOP_RENDERER_BUILD=always` when you need a guaranteed
 * clean bundle (lockfile or plugin changes the heuristic might miss).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "vite";
import {
  fileMtime,
  maxMtimeUnder as sourceMaxMtimeUnder,
} from "./artifact-staleness.ts";
import {
  readRendererBuildManifest,
  rendererBuildManifestMatchesDist,
} from "./renderer-build-manifest.ts";

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".json",
  ".svg",
  ".mjs",
]);

const SOURCE_EXCLUDES = new Set(["node_modules", "dist"]);
function maxMtimeUnder(dir: string) {
  return sourceMaxMtimeUnder(dir, {
    exclude: SOURCE_EXCLUDES,
    exts: TEXT_EXT,
    maxDepth: 20,
  });
}

function maxMtimeAcrossDirs(dirs: string[]) {
  let max = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    max = Math.max(max, maxMtimeUnder(dir));
  }
  return max;
}

/**
 * UI-smoke may reuse a renderer only when its test-auth build flag exactly
 * matches the current invocation. Missing legacy metadata fails closed.
 */
export function rendererDistMatchesPlaywrightTestAuth(
  appDir: string,
  expectedPlaywrightTestAuth: boolean,
  distDir = path.join(appDir, "web-dist"),
) {
  const manifest = readRendererBuildManifest(distDir);
  return (
    rendererBuildManifestMatchesDist(distDir, manifest) &&
    manifest.playwrightTestAuth === expectedPlaywrightTestAuth
  );
}

/** Resolve the UI-smoke auth variant with Vite's production env precedence. */
export function resolvePlaywrightTestAuth(appDir: string) {
  return (
    loadEnv("production", appDir, "VITE_").VITE_PLAYWRIGHT_TEST_AUTH === "true"
  );
}

/**
 * @param {string} appDir absolute path to packages/app
 * @param {string} repoRoot absolute path to repo root
 * @param {{ expectedPlaywrightTestAuth?: boolean, distDir?: string }} [options]
 */
export function viteRendererBuildNeeded(
  appDir: string,
  repoRoot: string,
  options: { expectedPlaywrightTestAuth?: boolean; distDir?: string } = {},
) {
  const distDir = options.distDir ?? path.join(appDir, "web-dist");
  const distIndex = path.join(distDir, "index.html");
  if (!fs.existsSync(distIndex)) {
    return true;
  }
  if (
    typeof options.expectedPlaywrightTestAuth === "boolean" &&
    !rendererDistMatchesPlaywrightTestAuth(
      appDir,
      options.expectedPlaywrightTestAuth,
      distDir,
    )
  ) {
    return true;
  }
  const manifest = readRendererBuildManifest(path.dirname(distIndex));
  const startedAt = Date.parse(manifest?.startedAt ?? "");
  const builtAt = Date.parse(manifest?.builtAt ?? "");
  // Legacy stamps record completion only; rebuild once to establish the input
  // boundary instead of accepting code changed after Vite already read it.
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(builtAt) ||
    startedAt > builtAt
  ) {
    return true;
  }
  const distMtime = Math.min(fileMtime(distIndex), startedAt);
  if (!distMtime) return true;

  const candidates = [
    path.join(appDir, "index.html"),
    path.join(appDir, "vite.config.ts"),
    path.join(appDir, ".env"),
    path.join(appDir, ".env.local"),
    path.join(appDir, ".env.production"),
    path.join(appDir, ".env.production.local"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p) && fileMtime(p) > distMtime) {
      return true;
    }
  }

  const srcDir = path.join(appDir, "src");
  if (fs.existsSync(srcDir) && maxMtimeUnder(srcDir) > distMtime) {
    return true;
  }

  const publicDir = path.join(appDir, "public");
  if (fs.existsSync(publicDir) && maxMtimeUnder(publicDir) > distMtime) {
    return true;
  }

  const viteDir = path.join(appDir, "vite");
  if (fs.existsSync(viteDir) && maxMtimeUnder(viteDir) > distMtime) {
    return true;
  }

  const uiSrcCandidates = [
    path.join(repoRoot, "packages", "ui", "src"),
    path.join(repoRoot, "eliza", "packages", "ui", "src"),
  ];
  if (maxMtimeAcrossDirs(uiSrcCandidates) > distMtime) {
    return true;
  }

  const appCoreSrcCandidates = [
    path.join(repoRoot, "packages", "app", "src"),
    path.join(repoRoot, "eliza", "packages", "app", "src"),
  ];
  if (maxMtimeAcrossDirs(appCoreSrcCandidates) > distMtime) {
    return true;
  }

  const pluginRootCandidates = [
    path.join(repoRoot, "plugins"),
    path.join(repoRoot, "eliza", "plugins"),
  ];
  for (const pluginsRoot of pluginRootCandidates) {
    if (!fs.existsSync(pluginsRoot)) continue;
    let pluginDirs: fs.Dirent[];
    try {
      pluginDirs = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      pluginDirs = [];
    }
    for (const ent of pluginDirs) {
      if (!ent.isDirectory()) continue;
      const pluginSrc = path.join(pluginsRoot, ent.name, "src");
      if (fs.existsSync(pluginSrc) && maxMtimeUnder(pluginSrc) > distMtime) {
        return true;
      }
    }
  }

  return false;
}
