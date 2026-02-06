import os from "node:os";
import path from "node:path";

const STATE_DIRNAME = ".milaidy";
const CONFIG_FILENAME = "milaidy.json";

function stateDir(homedir: () => string = os.homedir): string {
  return path.join(homedir(), STATE_DIRNAME);
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
  const override = env.MILAIDY_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return stateDir(homedir);
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = env.MILAIDY_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(stateDirPath, CONFIG_FILENAME);
}

export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const explicit = env.MILAIDY_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit)];
  }

  const milaidyStateDir = env.MILAIDY_STATE_DIR?.trim();
  if (milaidyStateDir) {
    const resolved = resolveUserPath(milaidyStateDir);
    return [path.join(resolved, CONFIG_FILENAME)];
  }

  return [path.join(stateDir(homedir), CONFIG_FILENAME)];
}

const OAUTH_FILENAME = "oauth.json";

export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
  const override = env.MILAIDY_OAUTH_DIR?.trim();
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
