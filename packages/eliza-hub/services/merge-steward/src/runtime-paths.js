import { homedir } from "node:os";
import path from "node:path";

const APP_DIR = "eliza-hub";

export function defaultCacheRoot(env = process.env) {
  if (env.ELIZA_CACHE_ROOT) return env.ELIZA_CACHE_ROOT;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, APP_DIR);

  const home = env.HOME || homedir();
  if (home) return path.join(home, ".cache", APP_DIR);

  return path.join("/var/tmp", APP_DIR, "cache");
}

export function defaultIntegrationWorkDir(env = process.env) {
  return path.join(defaultCacheRoot(env), "merge-steward-workdir");
}
