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

/** Cloud onboarding owns the one live lane that must leave first-run incomplete. */
export function shouldSkipLiveStackAutoFirstRun(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1";
}

export function createLiveRuntimeChildEnv(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const ambientCloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const cloudOnboardingLive = process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1";
  const cloudMediaLive = process.env.ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE === "1";
  const preserveAmbientCloudApiKey =
    (cloudOnboardingLive || cloudMediaLive) &&
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
  // Cloud onboarding and live-media lanes are the only exceptions: both need
  // the workflow-validated Cloud bearer beside the selected model provider.
  if (preserveAmbientCloudApiKey) {
    env.ELIZAOS_CLOUD_API_KEY = ambientCloudApiKey;
  }

  // The live voice lane uses Cloud only for STT/TTS. Make that ownership
  // explicit so preserving the bearer cannot also register Cloud's higher-
  // priority text handlers over the provider selected by first-run.
  if (cloudMediaLive && preserveAmbientCloudApiKey) {
    env.ELIZAOS_CLOUD_USE_INFERENCE = "false";
    env.ELIZAOS_CLOUD_USE_STT = "true";
    env.ELIZAOS_CLOUD_USE_TTS = "true";
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
