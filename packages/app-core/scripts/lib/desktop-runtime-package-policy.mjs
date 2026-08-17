/** Desktop runtime package reuse policy for the signed native bundle. */

/**
 * app-core is the embedded server entry, so a stale or partially-written dist
 * can make source-visible routes disappear from the packaged runtime. Its
 * build is cheap relative to packaging and must never use the mtime heuristic.
 */
export function canReuseDesktopRuntimePackage({
  packageName,
  forceRebuild,
  looksBuilt,
}) {
  if (forceRebuild) return false;
  if (packageName === "@elizaos/app-core") return false;
  return looksBuilt;
}
