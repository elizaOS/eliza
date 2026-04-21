/**
 * Sealed in-process secret store for cloud credentials.
 *
 * Cloud API keys are scrubbed from process.env after login and stored
 * here so they are not visible in environment dumps, child processes,
 * or /proc/self/environ.
 *
 * This module has NO external dependencies so it can be imported by
 * any module without pulling in @elizaos/agent or @elizaos/core.
 */

const _cloudSecrets: Record<string, string | undefined> = Object.create(null);

Object.defineProperty(_cloudSecrets, Symbol.toStringTag, {
  value: "CloudSecrets",
  enumerable: false,
});

/**
 * Read a cloud secret without exposing it in process.env.
 * Falls back to process.env for backwards compatibility with code that
 * sets the key before this module loads (e.g. docker entrypoints).
 */
export function getCloudSecret(
  key: "ELIZAOS_CLOUD_API_KEY" | "ELIZAOS_CLOUD_ENABLED",
): string | undefined {
  return _cloudSecrets[key] ?? process.env[key];
}

/** Scrub cloud secrets from process.env and capture into the sealed store. */
export function scrubCloudSecretsFromEnv(): void {
  for (const key of [
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
  ] as const) {
    if (process.env[key] !== undefined) {
      _cloudSecrets[key] = process.env[key];
      delete process.env[key];
    }
  }
}

/** Clear any sealed cloud secrets after an explicit disconnect. */
export function clearCloudSecrets(): void {
  for (const key of [
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
  ] as const) {
    delete _cloudSecrets[key];
  }
}

/** Reset the sealed secret store. Test-only. */
export function _resetCloudSecretsForTesting(): void {
  for (const key of Object.keys(_cloudSecrets)) {
    delete _cloudSecrets[key];
  }
}
