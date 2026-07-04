/** Supports app-core build, packaging, or development orchestration for node path env mjs. */
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
