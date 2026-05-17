import fs from "node:fs";
import path from "node:path";
import {
  buildIsolatedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
} from "./live-provider.ts";

function hasHostsOverride(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureSelfControlTestHostsPath(env: NodeJS.ProcessEnv): string | null {
  const configuredPath =
    env.WEBSITE_BLOCKER_HOSTS_FILE_PATH ?? env.SELFCONTROL_HOSTS_FILE_PATH;
  if (hasHostsOverride(configuredPath)) {
    return configuredPath;
  }

  const stateDir = env.ELIZA_STATE_DIR;
  if (!(typeof stateDir === "string" && stateDir.trim().length > 0)) {
    return null;
  }

  const hostsFilePath = path.join(stateDir, "selfcontrol-test-hosts");
  fs.mkdirSync(path.dirname(hostsFilePath), { recursive: true });
  if (!fs.existsSync(hostsFilePath)) {
    fs.writeFileSync(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
  }
  return hostsFilePath;
}

export function createLiveRuntimeChildEnv(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const liveProviderOverrides = Object.fromEntries(
    Object.entries(overrides).filter(
      ([key, value]) => value !== undefined && LIVE_PROVIDER_ENV_KEYS.has(key),
    ),
  );
  const env: NodeJS.ProcessEnv =
    Object.keys(liveProviderOverrides).length > 0
      ? buildIsolatedLiveProviderEnv(process.env, {
          env: liveProviderOverrides as Record<string, string>,
        })
      : { ...process.env };

  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete env[key];
    }
  }

  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const selfControlHostsPath = ensureSelfControlTestHostsPath(env);
  if (selfControlHostsPath) {
    env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = selfControlHostsPath;
    env.SELFCONTROL_HOSTS_FILE_PATH = selfControlHostsPath;
  }

  return env;
}
