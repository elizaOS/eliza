/**
 * Boot-time gate deciding whether the remote coding runner (cloud/home sandbox
 * executor) plugin should load. Returns true when a runner-mode setting or any
 * remote-runner base URL is configured, reading each key from runtime settings
 * first and falling back to the process env.
 */
import { ElizaError } from "@elizaos/core";

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

const ENABLED_RUNNER_MODES = new Set([
  "eliza-cloud",
  "elizacloud",
  "home",
  "home-machine",
  "cloudflare",
  "sandbox-agent",
  "rivet",
  "vercel",
]);

const DISABLED_RUNNER_MODES = new Set(["0", "false"]);

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

export function shouldLoadRemoteCodingRunnerForBoot(
  runtime: RuntimeSettingSource,
  env: EnvSource = process.env,
): boolean {
  for (const key of RUNNER_SETTING_KEYS) {
    const value = readSetting(runtime, env, key);
    if (value === undefined) continue;
    const normalized = value.toLowerCase();
    if (DISABLED_RUNNER_MODES.has(normalized)) return false;
    if (ENABLED_RUNNER_MODES.has(normalized)) return true;
    throw new ElizaError(`${key} names an unsupported remote runner mode`, {
      code: "REMOTE_CODING_RUNNER_MODE_INVALID",
      context: { setting: key },
      severity: "fatal",
    });
  }

  for (const key of REMOTE_RUNNER_URL_KEYS) {
    const value = readSetting(runtime, env, key);
    if (value === undefined) continue;
    validateRemoteRunnerUrl(value, key);
    return true;
  }
  return false;
}

function validateRemoteRunnerUrl(value: string, setting: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 Reject malformed boot configuration before module load.
    throw new ElizaError(`${setting} must be a valid HTTP(S) URL`, {
      code: "REMOTE_CODING_RUNNER_URL_INVALID",
      context: { setting },
      severity: "fatal",
    });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ElizaError(
      `${setting} must be an HTTP(S) URL without credentials, query, or fragment`,
      {
        code: "REMOTE_CODING_RUNNER_URL_INVALID",
        context: { setting, protocol: parsed.protocol },
        severity: "fatal",
      },
    );
  }
}
