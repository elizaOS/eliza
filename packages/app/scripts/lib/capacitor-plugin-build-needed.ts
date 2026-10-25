/** Native plugin freshness uses the same fail-fast source scan as other artifacts. */
import fs from "node:fs";
import path from "node:path";
import { artifactStaleness } from "./artifact-staleness.ts";

const SRC_EXTS = new Set([".ts", ".tsx"]);

function distMarkerPath(pluginRoot) {
  for (const relative of ["dist/esm/index.js", "dist/plugin.js"]) {
    const file = path.join(pluginRoot, relative);
    try {
      if (!fs.statSync(file).isFile()) {
        throw new Error(`Native plugin build marker is not a file: ${file}`);
      }
      return file;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

export function capacitorPluginsBuildNeeded(pluginsDir, pluginNames) {
  return pluginNames.some((name) => {
    const root = path.join(pluginsDir, `plugin-native-${name}`);
    const marker = distMarkerPath(root);
    return (
      !marker ||
      artifactStaleness(marker, {
        sourceDirs: [path.join(root, "src")],
        sourceFiles: ["package.json", "rollup.config.mjs", "tsconfig.json"].map(
          (file) => path.join(root, file),
        ),
        exts: SRC_EXTS,
      }).stale
    );
  });
}
