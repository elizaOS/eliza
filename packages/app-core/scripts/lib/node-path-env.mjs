import path from "node:path";

export function extendNodePathEnv(baseEnv, rootDir) {
  const rootModules = path.join(rootDir, "node_modules");
  return {
    ...baseEnv,
    NODE_PATH: baseEnv.NODE_PATH
      ? `${rootModules}${path.delimiter}${baseEnv.NODE_PATH}`
      : rootModules,
  };
}
