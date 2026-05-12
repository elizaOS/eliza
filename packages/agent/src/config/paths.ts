import fs from "node:fs";
import path from "node:path";
import {
  getElizaNamespace,
  resolveOAuthDir,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";

const CONFIG_PATH_OVERRIDE_KEYS = ["ELIZA_CONFIG_PATH"] as const;

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

export { getElizaNamespace, resolveOAuthDir, resolveStateDir, resolveUserPath };

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
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
): string[] {
  const explicit = readEnvOverride(env, CONFIG_PATH_OVERRIDE_KEYS);
  if (explicit) {
    return [resolveUserPath(explicit)];
  }

  const namespace = getElizaNamespace(env);
  const stateDirPath = resolveStateDir(env);
  const primary = path.join(stateDirPath, `${namespace}.json`);
  if (namespace === "eliza") {
    return [primary];
  }
  return [primary, path.join(stateDirPath, "eliza.json")];
}

const OAUTH_FILENAME = "oauth.json";

/**
 * Directory for per-provider model cache files.
 * Each provider gets its own file: `<state-dir>/models/<providerId>.json`
 */
export function resolveModelsCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  return path.join(stateDirPath, "models");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  return path.join(resolveOAuthDir(env, stateDirPath), OAUTH_FILENAME);
}

const STEWARD_CREDENTIALS_FILENAME = "steward-credentials.json";

/**
 * Canonical path to the persisted Steward credentials file.
 * Honors the `ELIZA_STATE_DIR` > `~/.${namespace}`
 * resolver.
 */
export function resolveStewardCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  return path.join(stateDirPath, STEWARD_CREDENTIALS_FILENAME);
}
