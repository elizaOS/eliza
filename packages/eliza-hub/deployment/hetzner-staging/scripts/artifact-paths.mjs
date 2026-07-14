import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const APP_DIR = "eliza-hub";

export function elizaCacheRoot(env = process.env) {
  if (env.ELIZA_CACHE_ROOT) return env.ELIZA_CACHE_ROOT;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, APP_DIR);

  const home = env.HOME || homedir();
  if (home) return path.join(home, ".cache", APP_DIR);

  return path.join("/var/tmp", APP_DIR, "cache");
}

export function elizaArtifactRoot(env = process.env) {
  if (env.ELIZA_ARTIFACT_ROOT) return env.ELIZA_ARTIFACT_ROOT;
  if (env.XDG_STATE_HOME)
    return path.join(env.XDG_STATE_HOME, APP_DIR, "artifacts");

  const home = env.HOME || homedir();
  if (home) return path.join(home, ".local", "state", APP_DIR, "artifacts");

  return path.join("/var/tmp", APP_DIR, "artifacts");
}

export function elizaTmpRoot(env = process.env) {
  return env.ELIZA_TMP_ROOT || path.join(elizaCacheRoot(env), "tmp");
}

export function artifactPath(filename, env = process.env) {
  return path.join(elizaArtifactRoot(env), filename);
}

export function tmpPath(filename, env = process.env) {
  return path.join(elizaTmpRoot(env), filename);
}

export function prepareParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}
