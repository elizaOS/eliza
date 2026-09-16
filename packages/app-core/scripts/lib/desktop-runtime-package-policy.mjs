/** Desktop runtime package reuse policy for the native bundle. */

/**
 * app-core, agent, and plugin-sql are embedded server authorities. Rebuilding
 * them for every desktop package prevents a fresh-looking but incomplete dist
 * from omitting source-visible routes, process bridge capabilities, or schema.
 */
export function canReuseDesktopRuntimePackage({
  packageName,
  forceRebuild,
  looksBuilt,
}) {
  if (forceRebuild) return false;
  if (
    packageName === "@elizaos/app-core" ||
    packageName === "@elizaos/agent" ||
    packageName === "@elizaos/plugin-sql"
  ) {
    return false;
  }
  return looksBuilt;
}
