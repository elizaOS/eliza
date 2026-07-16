/** Defines app-core live child env ts behavior for dashboard host and runtime integration. */
import fs from "node:fs";
import path from "node:path";
import {
  buildIsolatedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
} from "./live-provider.ts";

function hasNonWhitespaceValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureSelfControlTestHostsPath(env: NodeJS.ProcessEnv): string | null {
  const configuredPath =
    env.WEBSITE_BLOCKER_HOSTS_FILE_PATH ?? env.SELFCONTROL_HOSTS_FILE_PATH;
  if (hasNonWhitespaceValue(configuredPath)) {
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
  const ambientCloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const preserveAmbientCloudApiKey =
    process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1" &&
    hasNonWhitespaceValue(ambientCloudApiKey);
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

  // Provider isolation deliberately blanks every unselected credential. The
  // app Cloud-live lane is the sole exception: its onboarding runtime needs the
  // workflow-validated Cloud bearer in addition to the selected model provider.
  if (preserveAmbientCloudApiKey) {
    env.ELIZAOS_CLOUD_API_KEY = ambientCloudApiKey;
  }

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
