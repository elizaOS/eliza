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

import { randomBytes } from "node:crypto";
import {
  createManager,
  type SecretsManager,
  type Vault,
  VaultDecryptionError,
} from "@elizaos/vault";
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

/** Narrow surface of `Vault` used by the boot resolver and test fakes. */
export type VaultLike = Pick<Vault, "get" | "has">;

const OPTIMIZED_PROMPT_HMAC_VAULT_KEY = "system.optimized-prompt.hmac-key";
const OPTIMIZED_PROMPT_HMAC_RECOVERY_CALLER =
  "runtime-boot:optimized-prompt-hmac-decryption-recovery";

type OptimizedPromptIntegrityVault = Pick<
  Vault,
  "get" | "has" | "set" | "setIfAbsent"
>;

// `set()` is an encrypted UPSERT, not a compare-and-swap. Keep the complete
// read/recover/write/read-back sequence single-flight for the process-wide
// shared Vault instance so concurrent boot callers cannot return different
// replacement keys. PGlite remains the cross-process single-writer boundary.
const optimizedPromptIntegrityKeyResolutions = new WeakMap<
  object,
  Promise<string>
>();

function isOptimizedPromptIntegrityKeyDecryptionFailure(
  error: unknown,
): error is VaultDecryptionError {
  return (
    error instanceof VaultDecryptionError &&
    error.key === OPTIMIZED_PROMPT_HMAC_VAULT_KEY
  );
}

async function replaceUnreadableOptimizedPromptIntegrityKey(
  vault: OptimizedPromptIntegrityVault,
): Promise<string> {
  const replacement = randomBytes(32).toString("base64");
  await vault.set(OPTIMIZED_PROMPT_HMAC_VAULT_KEY, replacement, {
    sensitive: true,
    // This caller is persisted in the Vault audit log as the redacted reason;
    // no key material or underlying crypto error is logged.
    caller: OPTIMIZED_PROMPT_HMAC_RECOVERY_CALLER,
  });
  const readBack = await vault.get(OPTIMIZED_PROMPT_HMAC_VAULT_KEY);
  if (readBack !== replacement) {
    throw new Error(
      "[runtime-ops:vault] optimized-prompt integrity-key recovery failed exact read-back verification",
    );
  }
  return replacement;
}

async function readOptimizedPromptIntegrityKeyOrRecover(
  vault: OptimizedPromptIntegrityVault,
): Promise<string> {
  try {
    return await vault.get(OPTIMIZED_PROMPT_HMAC_VAULT_KEY);
  } catch (error) {
    // This is the sole recoverable decryption failure: the value is randomly
    // generated internal HMAC material, never a user/provider credential. A
    // replacement makes old optimized-prompt artifacts fail their HMAC check;
    // the core loader rejects them and falls back to baseline prompts.
    if (!isOptimizedPromptIntegrityKeyDecryptionFailure(error)) throw error;
    return replaceUnreadableOptimizedPromptIntegrityKey(vault);
  }
}

async function resolveOptimizedPromptIntegrityKeyOnce(
  vault: OptimizedPromptIntegrityVault,
): Promise<string> {
  if (await vault.has(OPTIMIZED_PROMPT_HMAC_VAULT_KEY)) {
    return readOptimizedPromptIntegrityKeyOrRecover(vault);
  }
  const key = randomBytes(32).toString("base64");
  const inserted = await vault.setIfAbsent(
    OPTIMIZED_PROMPT_HMAC_VAULT_KEY,
    key,
    {
      sensitive: true,
      caller: "runtime-boot",
    },
  );
  return inserted ? key : readOptimizedPromptIntegrityKeyOrRecover(vault);
}

/**
 * Return the persistent integrity key used to authenticate optimized prompts.
 * The vault is authoritative; a key is generated once and encrypted at rest.
 * Only authenticated-decryption failure for this exact regenerable system key
 * is repaired. All user/provider keys and every other error stay fail-closed.
 */
export async function resolveOptimizedPromptIntegrityKey(
  vault: OptimizedPromptIntegrityVault,
): Promise<string> {
  const existing = optimizedPromptIntegrityKeyResolutions.get(vault);
  if (existing) return existing;

  const resolution = resolveOptimizedPromptIntegrityKeyOnce(vault).finally(
    () => {
      if (optimizedPromptIntegrityKeyResolutions.get(vault) === resolution) {
        optimizedPromptIntegrityKeyResolutions.delete(vault);
      }
    },
  );
  optimizedPromptIntegrityKeyResolutions.set(vault, resolution);
  return resolution;
}

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

/**
 * Resolve `vault://<key>` sentinels found in connector env projections
 * (the output of `collectConnectorEnvVars`) into an env-key → plaintext
 * overlay for the runtime-settings projection.
 *
 * The overlay is delivered ONLY to the in-memory runtime settings map
 * (`AgentRuntime.settings`, read via `runtime.getSetting()`); callers MUST
 * NOT write resolved values into `process.env` — mirroring a resolved
 * connector secret into the environment leaks it to every child process and
 * co-tenant agent (the same invariant core's `getSetting()` documents).
 *
 * Fail-closed: a sentinel that cannot be resolved is reported in `failures`
 * by env key + vault key ONLY — never any value, and never the underlying
 * vault error (which could echo storage internals) — and the env key is
 * omitted from the overlay, so downstream consumers see the connector as
 * unconfigured instead of receiving the sentinel literal or a partial value.
 *
 * Non-sentinel entries are ignored here; the legacy plain-value path is
 * responsible for them (backward compatible by construction — the `vault://`
 * scheme is opt-in per value).
 */
export async function resolveConnectorSecretSettings(
  connectorEnvVars: Record<string, string>,
  vault: VaultLike,
): Promise<{ resolved: Record<string, string>; failures: string[] }> {
  const resolved: Record<string, string> = {};
  const failures: string[] = [];
  // Discord's token mirrors to two env keys from one vault entry — cache so
  // one vault read (and one audit record) covers both aliases.
  const cache = new Map<string, string | null>();

  for (const [envKey, value] of Object.entries(connectorEnvVars)) {
    if (!isVaultRef(value)) continue;
    const vaultKey = parseVaultRef(value);
    if (!vaultKey) {
      failures.push(`${envKey} (malformed vault ref)`);
      continue;
    }
    let secret = cache.get(vaultKey);
    if (secret === undefined) {
      try {
        secret = (await vault.has(vaultKey)) ? await vault.get(vaultKey) : null;
      } catch {
        // Redacted on purpose: the caught error is dropped, not rethrown or
        // stringified — key names are the only material that may surface.
        secret = null;
      }
      cache.set(vaultKey, secret);
    }
    if (secret === null || secret.length === 0) {
      failures.push(`${envKey} (vault://${vaultKey})`);
      continue;
    }
    resolved[envKey] = secret;
  }

  return { resolved, failures };
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
