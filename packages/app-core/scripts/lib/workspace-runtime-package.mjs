import fs from "node:fs";
import path from "node:path";
import { maxMtimeUnder } from "./artifact-staleness.mjs";

/** Resolve the generated runtime tree for workspace packages with nonstandard layouts. */
export function workspaceRuntimePackageDistDir(packageName, packageDir) {
  return packageName === "@elizaos/plugin-sql"
    ? path.join(packageDir, "src", "dist")
    : path.join(packageDir, "dist");
}

/** Required entrypoints that prove a runtime package build is structurally usable. */
export function workspaceRuntimePackageMarkersPresent(
  packageName,
  distDir,
  existsSync = fs.existsSync,
) {
  if (packageName === "@elizaos/core") {
    return (
      existsSync(path.join(distDir, "node", "index.node.js")) &&
      existsSync(path.join(distDir, "index.node.d.ts")) &&
      existsSync(path.join(distDir, "testing", "live-provider.d.ts"))
    );
  }

  if (packageName === "@elizaos/plugin-sql") {
    return (
      existsSync(path.join(distDir, "node", "index.node.js")) &&
      existsSync(path.join(distDir, "index.node.d.ts"))
    );
  }

  if (packageName === "@elizaos/ui") {
    return (
      existsSync(path.join(distDir, "index.js")) &&
      existsSync(path.join(distDir, "App.js")) &&
      existsSync(path.join(distDir, "components", "pages", "LogsView.js"))
    );
  }

  return true;
}

/**
 * Presence is insufficient for packaging: ignored generated plugin output can
 * survive a source rename and still import an API that no longer exists.
 */
export function workspaceRuntimePackageLooksBuilt(
  packageName,
  packageDir,
  { trustDist = false, log = console.log } = {},
) {
  const distDir = workspaceRuntimePackageDistDir(packageName, packageDir);
  if (!fs.existsSync(distDir)) return false;
  if (!workspaceRuntimePackageMarkersPresent(packageName, distDir))
    return false;
  if (trustDist) return true;

  const srcDir = path.join(packageDir, "src");
  if (!fs.existsSync(srcDir)) return true;
  const srcMtime = maxMtimeUnder(srcDir);
  const distMtime = maxMtimeUnder(distDir);
  if (srcMtime > distMtime) {
    log(
      `[desktop-build] ${packageName} dist is stale (src newer than dist) — rebuilding`,
    );
    return false;
  }
  return true;
}
