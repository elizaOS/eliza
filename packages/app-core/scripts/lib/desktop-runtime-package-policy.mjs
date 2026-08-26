/** Desktop runtime package reuse policy for the native bundle. */

/**
 * app-core and agent are the embedded server authorities. Rebuilding both on
 * every desktop package prevents a fresh-looking but incomplete dist from
 * omitting source-visible routes or process bridge capabilities.
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
