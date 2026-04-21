/**
 * Returns true if any Capacitor plugin under the given directory (typically
 * `eliza/packages/native-plugins`) needs a rebuild (missing dist or src /
 * config newer than dist marker).
 */
import fs from "node:fs";
import path from "node:path";

const SRC_EXTS = new Set([".ts", ".tsx"]);

function newestMtimeInDir(dir) {
  let max = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      const ext = path.extname(ent.name);
      if (!SRC_EXTS.has(ext)) continue;
      try {
        max = Math.max(max, fs.statSync(p).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return max;
}

function distMarkerPath(pluginRoot) {
  const esm = path.join(pluginRoot, "dist", "esm", "index.js");
  const legacy = path.join(pluginRoot, "dist", "plugin.js");
  if (fs.existsSync(esm)) return esm;
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

export function capacitorPluginsBuildNeeded(pluginsDir, pluginNames) {
  for (const name of pluginNames) {
    const root = path.join(pluginsDir, name);
    const marker = distMarkerPath(root);
    if (!marker) {
      return true;
    }
    let distMtime;
    try {
      distMtime = fs.statSync(marker).mtimeMs;
    } catch {
      return true;
    }
    const srcDir = path.join(root, "src");
    if (fs.existsSync(srcDir)) {
      const srcNewest = newestMtimeInDir(srcDir);
      if (srcNewest > distMtime) {
        return true;
      }
    }
    for (const cfg of ["rollup.config.mjs", "tsconfig.json"]) {
      const p = path.join(root, cfg);
      try {
        if (fs.existsSync(p) && fs.statSync(p).mtimeMs > distMtime) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}
