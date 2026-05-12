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

import { createManager, type SecretsManager, type Vault } from "@elizaos/vault";
import type { OperationErrorCode } from "./types.ts";

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

/** Sentinel prefix marking a config value that resolves through the vault. */
const VAULT_REF_PREFIX = "vault://";

/** Format a stable vault key into the `vault://<key>` sentinel form. */
export function formatVaultRef(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      `[runtime-ops:vault] formatVaultRef requires a non-empty key`,
    );
  }
  return `${VAULT_REF_PREFIX}${key}`;
}

/** Type guard: true when `value` is a `vault://<key>` sentinel string. */
export function isVaultRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(VAULT_REF_PREFIX) &&
    value.length > VAULT_REF_PREFIX.length
  );
}

/** Extract the underlying vault key from a sentinel; null if malformed. */
export function parseVaultRef(value: string): string | null {
  if (!isVaultRef(value)) return null;
  return value.slice(VAULT_REF_PREFIX.length);
}

/** Narrow surface of `Vault` used by the boot resolver — easier to stub. */
export type VaultLike = Pick<Vault, "get" | "has">;

/**
 * Walk an env-shaped record and replace `vault://<key>` sentinels with the
 * resolved vault values. Non-sentinel strings are passed through unchanged;
 * non-string values are dropped (process.env only accepts strings).
 *
 * Returns `missing` for sentinel keys the vault does not contain — callers
 * should warn but continue (the legacy hydrate-from-config-env path will run
 * next and may still backfill from non-sentinel sources).
 */
export async function resolveConfigEnvForProcess(
  envBag: Record<string, unknown> | undefined,
  vault: VaultLike,
): Promise<{ resolved: Record<string, string>; missing: string[] }> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  if (!envBag) return { resolved, missing };

  for (const [envKey, value] of Object.entries(envBag)) {
    if (typeof value !== "string") continue;
    if (!isVaultRef(value)) {
      resolved[envKey] = value;
      continue;
    }
    const vaultKey = parseVaultRef(value);
    if (!vaultKey) continue;
    if (!(await vault.has(vaultKey))) {
      missing.push(vaultKey);
      continue;
    }
    resolved[envKey] = await vault.get(vaultKey);
  }

  return { resolved, missing };
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
