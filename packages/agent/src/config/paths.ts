import fs from "node:fs";
import path from "node:path";
import {
  getElizaNamespace,
  migrateLegacyStateDir,
  readEnv,
  resolveOAuthDir,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";

const CONFIG_PATH_CANONICAL_KEY = "ELIZA_CONFIG_PATH";
const CONFIG_PATH_LEGACY_KEYS = ["MILADY_CONFIG_PATH"] as const;

/** Legacy on-disk config filename, read (but never written) for back-compat. */
const LEGACY_CONFIG_FILENAME = "milady.json";

function readEnvOverride(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(CONFIG_PATH_CANONICAL_KEY, CONFIG_PATH_LEGACY_KEYS, { env });
}

export {
  getElizaNamespace,
  migrateLegacyStateDir,
  resolveOAuthDir,
  resolveStateDir,
  resolveUserPath,
};

/**
 * Ordered list of on-disk config filenames to look for under the state dir,
 * given the active namespace. The first existing file wins; if none exist,
 * callers fall back to the first entry (the file to create/write).
 */
function configFilenameCandidates(namespace: string): string[] {
  const candidates = [`${namespace}.json`];
  if (namespace !== "eliza") candidates.push("eliza.json");
  // Pre-rename installs persisted to `milady.json` — read it if nothing newer exists.
  candidates.push(LEGACY_CONFIG_FILENAME);
  return candidates;
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  const override = readEnvOverride(env);
  if (override) {
    return resolveUserPath(override);
  }

  const namespace = getElizaNamespace(env);
  const candidates = configFilenameCandidates(namespace).map((name) =>
    path.join(stateDirPath, name),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing on disk yet → the primary (canonical) path is the one to create.
  return candidates[0] ?? path.join(stateDirPath, `${namespace}.json`);
}

export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = readEnvOverride(env);
  if (explicit) {
    return [resolveUserPath(explicit)];
  }

  const namespace = getElizaNamespace(env);
  const stateDirPath = resolveStateDir(env);
  return configFilenameCandidates(namespace).map((name) =>
    path.join(stateDirPath, name),
  );
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
 * Honors the `ELIZA_STATE_DIR` (legacy `MILADY_STATE_DIR`) > `~/.${namespace}`
 * resolver.
 */
export function resolveStewardCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  return path.join(stateDirPath, STEWARD_CREDENTIALS_FILENAME);
}
