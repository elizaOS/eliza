/**
 * On-disk path resolution for agent state files, keyed off the canonical
 * state-dir and namespace resolvers. Locates the active config file (honoring
 * ELIZA_CONFIG_PATH and namespace-ordered filename candidates) and derives the
 * per-provider models cache directory and the Steward credentials file.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getElizaNamespace,
  readEnv,
  resolveOAuthDir,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";

const CONFIG_PATH_CANONICAL_KEY = "ELIZA_CONFIG_PATH";

function readEnvOverride(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(CONFIG_PATH_CANONICAL_KEY, { env });
}

export { getElizaNamespace, resolveOAuthDir, resolveStateDir, resolveUserPath };

/**
 * Ordered list of on-disk config filenames to look for under the state dir,
 * given the active namespace. The first existing file wins; if none exist,
 * callers fall back to the first entry (the file to create/write).
 */
function configFilenameCandidates(namespace: string): string[] {
  const candidates = [`${namespace}.json`];
  if (namespace !== "eliza") candidates.push("eliza.json");
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

const STEWARD_CREDENTIALS_FILENAME = "steward-credentials.json";

/**
 * Canonical path to the persisted Steward credentials file.
 * Honors the canonical state-dir resolver.
 */
export function resolveStewardCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  return path.join(stateDirPath, STEWARD_CREDENTIALS_FILENAME);
}
