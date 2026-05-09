import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readEnvOverride(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function getElizaNamespace(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = readEnvOverride(env, ["ELIZA_NAMESPACE"]);
  return override && override.length > 0 ? override : "eliza";
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = readEnvOverride(env, ["ELIZA_STATE_DIR"]);
  if (override) return resolveUserPath(override);
  return path.join(homedir(), `.${getElizaNamespace(env)}`);
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = readEnvOverride(env, ["ELIZA_CONFIG_PATH"]);
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
