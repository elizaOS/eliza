import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR_OVERRIDE_KEYS = [
  "MILADY_STATE_DIR",
  "ELIZA_STATE_DIR",
] as const;
const CONFIG_PATH_OVERRIDE_KEYS = [
  "MILADY_CONFIG_PATH",
  "ELIZA_CONFIG_PATH",
] as const;

function readEnvOverride(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function getElizaNamespace(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = readEnvOverride(env, ["ELIZA_NAMESPACE"]);
  return override && override.length > 0 ? override : "eliza";
}

function stateDir(
  homedir: () => string = os.homedir,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const namespace = getElizaNamespace(env);
  return path.join(homedir(), `.${namespace}`);
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = readEnvOverride(env, STATE_DIR_OVERRIDE_KEYS);
  if (override) {
    return resolveUserPath(override);
  }
  return stateDir(homedir, env);
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = readEnvOverride(env, CONFIG_PATH_OVERRIDE_KEYS);
  if (override) {
    return resolveUserPath(override);
  }

  const namespace = getElizaNamespace(env);
  const primaryPath = path.join(stateDirPath, `${namespace}.json`);
  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  if (namespace !== "eliza") {
    const legacyPath = path.join(stateDirPath, "eliza.json");
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
  }

  return primaryPath;
}

export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const explicit = readEnvOverride(env, CONFIG_PATH_OVERRIDE_KEYS);
  if (explicit) {
    return [resolveUserPath(explicit)];
  }

  const namespace = getElizaNamespace(env);

  const stateDirOverride = readEnvOverride(env, STATE_DIR_OVERRIDE_KEYS);
  if (stateDirOverride) {
    const resolved = resolveUserPath(stateDirOverride);
    const primary = path.join(resolved, `${namespace}.json`);
    if (namespace === "eliza") {
      return [primary];
    }
    return [primary, path.join(resolved, "eliza.json")];
  }

  const primaryStateDir = stateDir(homedir, env);
  if (namespace === "eliza") {
    return [path.join(primaryStateDir, "eliza.json")];
  }

  return [
    path.join(primaryStateDir, `${namespace}.json`),
    path.join(path.join(homedir(), ".eliza"), "eliza.json"),
  ];
}

const OAUTH_FILENAME = "oauth.json";

/**
 * Directory for per-provider model cache files.
 * Each provider gets its own file: `~/.eliza/models/<providerId>.json`
 */
export function resolveModelsCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  return path.join(stateDirPath, "models");
}

export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = readEnvOverride(env, ["ELIZA_OAUTH_DIR"]);
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(stateDirPath, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  return path.join(resolveOAuthDir(env, stateDirPath), OAUTH_FILENAME);
}

const STEWARD_CREDENTIALS_FILENAME = "steward-credentials.json";

/**
 * Canonical path to the persisted Steward credentials file.
 * Honors `MILADY_STATE_DIR` / `ELIZA_STATE_DIR` / `ELIZA_NAMESPACE`; falls back
 * to `~/.<namespace>/steward-credentials.json` (default namespace = `eliza`).
 */
export function resolveStewardCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  return path.join(stateDirPath, STEWARD_CREDENTIALS_FILENAME);
}
