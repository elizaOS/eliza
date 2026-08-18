/**
 * Normalizes the retired OpenCode provider environment into the canonical
 * eliza-code namespace before an elizaOS coding-agent process is spawned.
 */
import { readConfigEnvKey } from "./config-env.js";

const PROVIDER_ENV_SUFFIXES = [
  "API_KEY",
  "BASE_URL",
  "LOCAL",
  "MODEL_POWERFUL",
  "MODEL_FAST",
] as const;

type SettingReader = (key: string) => string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Applies canonical-over-legacy precedence and removes legacy names from the
 * child environment. Runtime/config values are consulted so UI saves apply to
 * the next spawn without requiring a host restart.
 */
export function applyElizaCodeProviderEnv(
  env: NodeJS.ProcessEnv,
  readSetting: SettingReader = readConfigEnvKey,
): void {
  for (const suffix of PROVIDER_ENV_SUFFIXES) {
    const canonicalKey = `ELIZA_CODE_${suffix}`;
    const legacyKey = `ELIZA_OPENCODE_${suffix}`;
    const value =
      nonEmpty(env[canonicalKey]) ??
      nonEmpty(readSetting(canonicalKey)) ??
      nonEmpty(env[legacyKey]) ??
      nonEmpty(readSetting(legacyKey));

    if (value) env[canonicalKey] = value;
    else delete env[canonicalKey];
    delete env[legacyKey];
  }
}
