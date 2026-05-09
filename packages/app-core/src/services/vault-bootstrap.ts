/**
 * Boot-time secret hydration: walk known plaintext sources, push sensitive
 * values to the shared vault, and rewrite the on-disk plaintext to
 * `vault://<KEY>` sentinels.
 *
 * Sources (in order):
 *   1. eliza.json `env[KEY]` and `env.vars[KEY]`
 *   2. `<stateDir>/config.env`
 *   3. eliza.json `plugins.entries[<id>].config[KEY]`
 *   4. `process.env[KEY]` for keys flagged sensitive in any registered plugin
 *      (does not mutate process.env — only mirrors to the vault).
 *
 * Idempotent by `vault.has(key)` per-key checks — no separate marker
 * file. Re-running the bootstrap after a partial run is safe and cheap;
 * only keys not already in the vault get re-attempted. Per-key
 * failures are isolated; if every write fails the function throws.
 */

import {
  type ElizaConfig,
  formatVaultRef,
  isVaultRef,
  loadElizaConfig,
  persistConfigEnv,
  readConfigEnv,
  resolveStateDir,
  saveElizaConfig,
} from "@elizaos/agent";
import { logger } from "@elizaos/core";
import type { Vault } from "@elizaos/vault";

import { loadRegistry } from "../registry";
import { sharedVault } from "./vault-mirror";

export interface VaultBootstrapResult {
  migrated: number;
  failed: string[];
}

interface VaultBootstrapOptions {
  configPath?: string;
  stateDir?: string;
  /** Test seam — defaults to `sharedVault()`. */
  vault?: Vault;
}

// Inlined helper instead of a `const ENV_VAR_KEY = /.../` module-scope
// binding because Bun.build (1.3.13) collapses such top-level `const` regex
// literals into `var ENV_VAR_KEY` declarations whose initialiser sits inside
// an `__esm` wrapper. On the on-device runtime that wrapper sometimes fails
// to fire before the first call site, leaving `ENV_VAR_KEY` undefined and
// throwing `TypeError: undefined is not an object (evaluating
// 'ENV_VAR_KEY.test')` mid-vault-bootstrap. A function returning the regex
// stays callable regardless of init order.
function isEnvVarKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

function inferSensitiveByHeuristic(key: string): boolean {
  return /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i.test(
    key,
  );
}

/** Build the set of plugin-config keys flagged sensitive in the registry. */
function sensitiveKeysFromRegistry(): Set<string> {
  const keys = new Set<string>();
  const registry = loadRegistry();
  for (const entry of registry.all) {
    for (const [fieldKey, field] of Object.entries(entry.config)) {
      if (field.sensitive === true) keys.add(fieldKey);
    }
  }
  return keys;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk eliza.json env / env.vars / plugins.entries[*].config in place,
 * pushing sensitive plaintext values to the vault and replacing them with
 * sentinels. Returns the keys we attempted to migrate plus the failures.
 */
async function migrateElizaJson(
  config: ElizaConfig,
  vault: Vault,
  sensitiveKeys: ReadonlySet<string>,
): Promise<{
  migrated: string[];
  skipped: string[];
  failed: string[];
  mutated: boolean;
}> {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let mutated = false;

  async function tryMigrate(
    container: Record<string, unknown>,
    key: string,
  ): Promise<void> {
    const value = container[key];
    if (typeof value !== "string" || value.length === 0) return;
    if (isVaultRef(value)) {
      skipped.push(key);
      return;
    }
    const isSensitive =
      sensitiveKeys.has(key) || inferSensitiveByHeuristic(key);
    if (!isSensitive) return;
    try {
      await vault.set(key, value, { sensitive: true });
      container[key] = formatVaultRef(key);
      migrated.push(key);
      mutated = true;
    } catch (err) {
      failed.push(key);
      logger.error(
        { err, key },
        "[vault-bootstrap] failed to migrate eliza.json secret",
      );
    }
  }

  const env = (config as { env?: unknown }).env;
  if (isPlainRecord(env)) {
    for (const key of Object.keys(env)) {
      if (!isEnvVarKey(key)) continue;
      await tryMigrate(env, key);
    }
    const vars = (env as { vars?: unknown }).vars;
    if (isPlainRecord(vars)) {
      for (const key of Object.keys(vars)) {
        if (!isEnvVarKey(key)) continue;
        await tryMigrate(vars, key);
      }
    }
  }

  const plugins = (config as { plugins?: unknown }).plugins;
  if (isPlainRecord(plugins)) {
    const entries = (plugins as { entries?: unknown }).entries;
    if (isPlainRecord(entries)) {
      for (const entryValue of Object.values(entries)) {
        if (!isPlainRecord(entryValue)) continue;
        const entryConfig = entryValue.config;
        if (!isPlainRecord(entryConfig)) continue;
        for (const fieldKey of Object.keys(entryConfig)) {
          await tryMigrate(entryConfig, fieldKey);
        }
      }
    }
  }

  return { migrated, skipped, failed, mutated };
}

async function migrateConfigEnvFile(
  stateDir: string,
  vault: Vault,
  sensitiveKeys: ReadonlySet<string>,
): Promise<{ migrated: string[]; skipped: string[]; failed: string[] }> {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const entries = await readConfigEnv(stateDir);
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (isVaultRef(value)) {
      skipped.push(key);
      continue;
    }
    const isSensitive =
      sensitiveKeys.has(key) || inferSensitiveByHeuristic(key);
    if (!isSensitive) continue;
    try {
      await vault.set(key, value, { sensitive: true });
      await persistConfigEnv(key, formatVaultRef(key), { stateDir });
      migrated.push(key);
    } catch (err) {
      failed.push(key);
      logger.error(
        { err, key },
        "[vault-bootstrap] failed to migrate config.env secret",
      );
    }
  }

  return { migrated, skipped, failed };
}

async function mirrorProcessEnvSensitive(
  vault: Vault,
  sensitiveKeys: ReadonlySet<string>,
  seenKeys: ReadonlySet<string>,
): Promise<{ migrated: string[]; failed: string[] }> {
  const migrated: string[] = [];
  const failed: string[] = [];

  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!isEnvVarKey(key)) continue;
    if (seenKeys.has(key)) continue;
    if (typeof rawValue !== "string" || rawValue.length === 0) continue;
    if (isVaultRef(rawValue)) continue;
    const isSensitive =
      sensitiveKeys.has(key) || inferSensitiveByHeuristic(key);
    if (!isSensitive) continue;
    if (await vault.has(key)) continue;
    try {
      await vault.set(key, rawValue, { sensitive: true });
      migrated.push(key);
    } catch (err) {
      failed.push(key);
      logger.error(
        { err, key },
        "[vault-bootstrap] failed to mirror process.env secret",
      );
    }
  }

  return { migrated, failed };
}

export async function runVaultBootstrap(
  opts: VaultBootstrapOptions = {},
): Promise<VaultBootstrapResult> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const vault = opts.vault ?? sharedVault();

  const sensitiveKeys = sensitiveKeysFromRegistry();
  const config = loadElizaConfig();

  const json = await migrateElizaJson(config, vault, sensitiveKeys);
  if (json.mutated) {
    saveElizaConfig(config);
  }

  const env = await migrateConfigEnvFile(stateDir, vault, sensitiveKeys);

  // Skip keys we already attempted (success or fail) so process.env
  // mirroring doesn't double-count keys that just failed against the json
  // file or the config.env file.
  const seen = new Set<string>([
    ...json.migrated,
    ...json.failed,
    ...env.migrated,
    ...env.failed,
  ]);
  const proc = await mirrorProcessEnvSensitive(vault, sensitiveKeys, seen);

  const migratedKeys = [...json.migrated, ...env.migrated, ...proc.migrated];
  const skippedKeys = [...json.skipped, ...env.skipped];
  const failedKeys = [...json.failed, ...env.failed, ...proc.failed];

  const attempted = migratedKeys.length + failedKeys.length;
  if (attempted > 0 && migratedKeys.length === 0) {
    throw new Error(
      `[vault-bootstrap] all ${failedKeys.length} secret writes failed; vault unreachable`,
    );
  }

  if (migratedKeys.length > 0 || failedKeys.length > 0) {
    logger.info(
      `[vault-bootstrap] migrated=${migratedKeys.length} skipped=${skippedKeys.length} failed=${failedKeys.length}`,
    );
  } else {
    logger.debug("[vault-bootstrap] no plaintext secrets to migrate");
  }

  return {
    migrated: migratedKeys.length,
    failed: failedKeys,
  };
}
