/**
 * Boot-time gate deciding whether the remote coding runner (cloud/home sandbox
 * executor) plugin should load. Returns true when a runner-mode setting is set,
 * the E2B remote-runner flag is truthy, or any remote-runner base URL is
 * configured, reading each key from the runtime settings first and falling back
 * to the process env.
 */
interface RuntimeSettingSource {
  getSetting(key: string): unknown;
}

type EnvSource = Record<string, string | undefined>;

const RUNNER_SETTING_KEYS = [
  "ELIZA_CODING_REMOTE_RUNNER",
  "ELIZA_REMOTE_RUNNER",
] as const;

const REMOTE_RUNNER_URL_KEYS = [
  "ELIZA_CLOUD_SANDBOX_BASE_URL",
  "ELIZA_CLOUD_REMOTE_RUNNER_URL",
  "ELIZA_CLOUD_RUNNER_URL",
  "ELIZA_HOME_REMOTE_RUNNER_URL",
  "ELIZA_HOME_RUNNER_URL",
] as const;

function readSetting(
  runtime: RuntimeSettingSource,
  env: EnvSource,
  key: string,
): string | undefined {
  const fromRuntime = runtime.getSetting(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function truthySetting(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldLoadRemoteCodingRunnerForBoot(
  runtime: RuntimeSettingSource,
  env: EnvSource = process.env,
): boolean {
  if (RUNNER_SETTING_KEYS.some((key) => readSetting(runtime, env, key))) {
    return true;
  }
  if (truthySetting(readSetting(runtime, env, "ELIZA_E2B_REMOTE_RUNNER"))) {
    return true;
  }
  return REMOTE_RUNNER_URL_KEYS.some((key) => readSetting(runtime, env, key));
}
