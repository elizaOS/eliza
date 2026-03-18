import os from "node:os";
import path from "node:path";

export function getElizaNamespace(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.ELIZA_NAMESPACE?.trim();
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
  const override = env.ELIZA_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return stateDir(homedir, env);
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = env.ELIZA_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  const namespace = getElizaNamespace(env);
  return path.join(stateDirPath, `${namespace}.json`);
}

export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const explicit = env.ELIZA_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit)];
  }

  const namespace = getElizaNamespace(env);

  const elizaStateDir = env.ELIZA_STATE_DIR?.trim();
  if (elizaStateDir) {
    const resolved = resolveUserPath(elizaStateDir);
    return [path.join(resolved, `${namespace}.json`)];
  }

  return [path.join(stateDir(homedir, env), `${namespace}.json`)];
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
  const override = env.ELIZA_OAUTH_DIR?.trim();
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
