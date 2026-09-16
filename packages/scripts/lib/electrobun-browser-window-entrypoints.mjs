import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Returns the BrowserWindow sources actually shipped by an Electrobun package.
 * Clean installs can contain only the shared `dist` source; Electrobun's own
 * postinstall may later mirror it into the platform-specific distribution.
 */
export function findElectrobunBrowserWindowEntrypoints(
  packageRoot,
  pathExists = existsSync,
) {
  return ["dist", "dist-linux-x64"]
    .map((distName) =>
      path.join(
        packageRoot,
        distName,
        "api",
        "bun",
        "core",
        "BrowserWindow.ts",
      ),
    )
    .filter((candidate) => pathExists(candidate));
}

/**
 * Distinguishes an expected `--ignore-scripts` install from a partially
 * materialized native distribution. The former may be deferred during the
 * repository's general postinstall; the latter remains a fail-closed error.
 */
export function classifyElectrobunLinuxNativeArtifacts(
  packageRoot,
  pathExists = existsSync,
) {
  const distDir = path.join(packageRoot, "dist-linux-x64");
  const targetPath = path.join(distDir, "libNativeWrapper_cef.so");
  const bspatchPath = path.join(distDir, "bspatch");
  const targetExists = pathExists(targetPath);
  const bspatchExists = pathExists(bspatchPath);

  return {
    bspatchPath,
    distDir,
    state:
      targetExists && bspatchExists
        ? "complete"
        : targetExists || bspatchExists
          ? "incomplete"
          : "absent",
    targetPath,
  };
}
