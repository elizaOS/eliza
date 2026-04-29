/**
 * Vault bridge — the only place runtime-ops talks to `@elizaos/vault`.
 *
 * Enforces:
 *   1. The naming convention for provider API key vault entries
 *      (`providers.<normalizedProvider>.api-key`).
 *   2. Sensitive flag on every write (so the secret is encrypted at rest).
 *   3. Caller tagging for the audit log so a reader of
 *      `<stateDir>/audit/vault.jsonl` can attribute every access to a
 *      runtime-ops phase.
 *
 * The bridge owns NO mutable state. Either pass an explicit
 * SecretsManager (tests), or call `defaultSecretsManager()` (production)
 * which constructs a fresh manager backed by the OS-keychain vault.
 */

import { createManager, type SecretsManager } from "@elizaos/vault";
import type { OperationErrorCode } from "./types.js";

export class VaultResolveError extends Error {
  readonly code: OperationErrorCode = "vault-resolve-failed";

  constructor(apiKeyRef: string, cause: unknown) {
    super(
      `[runtime-ops:vault] failed to resolve ${apiKeyRef}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "VaultResolveError";
  }
}

/** Stable vault key for a provider API key. */
export function vaultKeyForProviderApiKey(normalizedProvider: string): string {
  if (!normalizedProvider || normalizedProvider.includes(".")) {
    throw new TypeError(
      `[runtime-ops:vault] invalid provider id: ${JSON.stringify(normalizedProvider)}`,
    );
  }
  return `providers.${normalizedProvider}.api-key`;
}

/**
 * Persist a provider API key in the vault under the canonical key name and
 * return the vault key (the `apiKeyRef`).
 *
 * This is the single write path used by `provider-switch-routes.ts`. The
 * route MUST persist the secret here BEFORE constructing the
 * `ProviderSwitchIntent` so the intent never carries plaintext.
 */
export async function persistProviderApiKey(opts: {
  secrets: SecretsManager;
  normalizedProvider: string;
  apiKey: string;
  caller: string;
}): Promise<string> {
  const ref = vaultKeyForProviderApiKey(opts.normalizedProvider);
  await opts.secrets.vault.set(ref, opts.apiKey, {
    sensitive: true,
    caller: opts.caller,
  });
  return ref;
}

/**
 * Resolve a stored API key for the in-memory `process.env` write path.
 *
 * Returns `undefined` only when `apiKeyRef` is absent. If a ref is present,
 * the operation must fail loudly when the vault cannot resolve it; otherwise a
 * provider switch can appear successful while running with no key or a stale
 * key from process.env.
 *
 * The caller is recorded on each successful read.
 */
export async function resolveProviderApiKey(opts: {
  secrets: SecretsManager;
  apiKeyRef: string | undefined;
  caller: string;
}): Promise<string | undefined> {
  if (!opts.apiKeyRef) return undefined;
  try {
    return await opts.secrets.vault.reveal(opts.apiKeyRef, opts.caller);
  } catch (err) {
    throw new VaultResolveError(opts.apiKeyRef, err);
  }
}

let cached: SecretsManager | null = null;

/**
 * Lazy default manager. Production code paths construct a fresh manager
 * the first time runtime-ops needs the vault; tests inject their own.
 */
export function defaultSecretsManager(): SecretsManager {
  if (!cached) cached = createManager();
  return cached;
}

/** Test hook: drop the cached manager. */
export function _resetDefaultSecretsManagerForTesting(): void {
  cached = null;
}
