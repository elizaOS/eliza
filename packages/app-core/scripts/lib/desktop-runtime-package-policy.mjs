/** Desktop runtime package reuse policy for the signed native bundle. */

/**
 * app-core and agent are the embedded server authorities, so a stale or
 * partially-written dist can make source-visible routes or bridge capabilities
 * disappear from the packaged runtime. Their builds are cheap relative to
 * packaging and must never use the mtime heuristic.
 */
export function canReuseDesktopRuntimePackage({
  packageName,
  forceRebuild,
  looksBuilt,
}) {
  if (forceRebuild) return false;
  if (packageName === "@elizaos/app-core" || packageName === "@elizaos/agent") {
    return false;
  }
  return looksBuilt;
}
