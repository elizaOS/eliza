/**
 * Sealed, non-enumerable store for cloud API secrets.
 *
 * The upstream `@elizaos/agent` cloud-routes handler writes
 * `ELIZAOS_CLOUD_API_KEY` directly to `process.env` on login, making it
 * readable by any module and visible in crash dumps. This module provides:
 *
 * 1. A sealed store accessible only via `getCloudSecret()`.
 * 2. `scrubCloudKeyFromEnv()` to delete the key from `process.env` after
 *    each request while preserving access via the sealed store.
 * 3. A Docker/entrypoint fallback: if the key was set in the environment
 *    before the module loaded, `getCloudSecret()` still returns it.
 */

const CLOUD_KEY_NAME = "ELIZAOS_CLOUD_API_KEY";

/**
 * Internal sealed store.  The property is non-enumerable and non-configurable
 * so `Object.keys()`, `JSON.stringify()`, and `for…in` never expose it.
 */
const _store: Record<string, string | undefined> = Object.create(null);
Object.defineProperty(_store, "_secret", {
  value: undefined as string | undefined,
  writable: true,
  enumerable: false,
  configurable: false,
});

/** Capture any value that was already set before the module loaded (Docker). */
const _dockerFallback: string | undefined = process.env[CLOUD_KEY_NAME];

/**
 * Store the cloud secret in the sealed object and remove it from
 * `process.env` so it cannot leak via `JSON.stringify(process.env)`,
 * `/proc/self/environ`, crash dumps, or child processes.
 */
export function scrubCloudKeyFromEnv(): void {
  const current = process.env[CLOUD_KEY_NAME];
  if (current !== undefined) {
    (_store as { _secret: string | undefined })._secret = current;
    delete process.env[CLOUD_KEY_NAME];
  }
}

/**
 * Retrieve the cloud API key.
 *
 * Resolution order:
 * 1. Sealed store (set via `scrubCloudKeyFromEnv`)
 * 2. `process.env.ELIZAOS_CLOUD_API_KEY` (Docker entrypoint fallback)
 * 3. Value captured at module load time
 */
export function getCloudSecret(): string | undefined {
  return (
    (_store as { _secret: string | undefined })._secret ??
    process.env[CLOUD_KEY_NAME] ??
    _dockerFallback
  );
}

/**
 * Check that the internal store is truly non-enumerable.
 * Useful for assertions in tests.
 */
export function isStoreNonEnumerable(): boolean {
  return !Object.keys(_store).includes("_secret");
}

/** @internal — test-only reset */
export function __resetCloudSecretStoreForTests(): void {
  if (process.env.NODE_ENV === "production") return;
  (_store as { _secret: string | undefined })._secret = undefined;
}
