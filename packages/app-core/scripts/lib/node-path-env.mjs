/**
 * Extends a child environment's NODE_PATH with the workspace's node_modules
 * (including the .bun dir) so spawned tools resolve workspace packages.
 */
import path from "node:path";

export function extendNodePathEnv(baseEnv, rootDir) {
  const rootModules = path.join(rootDir, "node_modules");
  const bunModules = path.join(rootModules, ".bun", "node_modules");
  const modulePaths = [rootModules, bunModules];
  return {
    ...baseEnv,
    NODE_PATH: baseEnv.NODE_PATH
      ? `${modulePaths.join(path.delimiter)}${path.delimiter}${baseEnv.NODE_PATH}`
      : modulePaths.join(path.delimiter),
  };
}
