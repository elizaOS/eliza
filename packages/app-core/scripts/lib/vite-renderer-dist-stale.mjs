/**
 * Returns true when the main app needs a production `vite build` before Electrobun dev.
 *
 * Uses **mtime** of `dist/index.html` vs. app sources, shared packages, and key config files.
 * **Why not always build:** A full Vite production compile is expensive; skipping when dist
 * is fresh makes `dev:desktop` restarts fast. **Why mtime:** Good enough for local dev; use
 * `--force-renderer` / `ELIZA_DESKTOP_RENDERER_BUILD=always` when you need a guaranteed
 * clean bundle (lockfile or plugin changes the heuristic might miss).
 */
import fs from "node:fs";
import path from "node:path";

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".json",
  ".svg",
  ".mjs",
]);

function maxMtimeUnder(dir, { maxDepth = 20 } = {}) {
  let max = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(ent.name);
      if (!TEXT_EXT.has(ext)) continue;
      try {
        max = Math.max(max, fs.statSync(p).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir, 0);
  return max;
}

function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function maxMtimeAcrossDirs(dirs) {
  let max = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    max = Math.max(max, maxMtimeUnder(dir));
  }
  return max;
}

/**
 * @param {string} appDir absolute path to packages/app
 * @param {string} repoRoot absolute path to repo root
 */
export function viteRendererBuildNeeded(appDir, repoRoot) {
  const distIndex = path.join(appDir, "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    return true;
  }
  const distMtime = fileMtime(distIndex);
  if (!distMtime) return true;

  const candidates = [
    path.join(appDir, "index.html"),
    path.join(appDir, "vite.config.ts"),
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

  const uiSrcCandidates = [
    path.join(repoRoot, "packages", "ui", "src"),
    path.join(repoRoot, "eliza", "packages", "ui", "src"),
  ];
  if (maxMtimeAcrossDirs(uiSrcCandidates) > distMtime) {
    return true;
  }

  const appCoreSrcCandidates = [
    path.join(repoRoot, "packages", "app-core", "src"),
    path.join(repoRoot, "eliza", "packages", "app-core", "src"),
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
    let pluginDirs;
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
