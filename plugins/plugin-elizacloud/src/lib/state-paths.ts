import fs from "node:fs";
import path from "node:path";
import {
  getElizaNamespace,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";

export { getElizaNamespace, resolveStateDir, resolveUserPath };

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  const override = env.ELIZA_CONFIG_PATH?.trim();
  if (override) return resolveUserPath(override);

  const namespace = getElizaNamespace(env);
  const primaryPath = path.join(stateDirPath, `${namespace}.json`);
  if (fs.existsSync(primaryPath)) return primaryPath;

  if (namespace !== "eliza") {
    const legacyPath = path.join(stateDirPath, "eliza.json");
    if (fs.existsSync(legacyPath)) return legacyPath;
  }

  return primaryPath;
}
