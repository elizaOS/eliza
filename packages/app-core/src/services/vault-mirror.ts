/**
 * Write-through mirror to @elizaos/vault for plugin sensitive fields.
 *
 * Extracted from plugins-routes.ts so unit tests can exercise the
 * mirror logic without dragging in the entire @elizaos/agent runtime.
 *
 * Concurrency: the vault PUT path is hit concurrently when the UI saves
 * multiple plugin configs in parallel. `VaultImpl.mutate()` has its own
 * process and filesystem locks; the process-level manager cache keeps the
 * plugin-save path and `/api/secrets/manager/*` routes sharing one facade.
 */

import { logger } from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
import { createManager, type SecretsManager, type Vault } from "@elizaos/vault";

let cachedManager: SecretsManager | null = null;

export function sharedSecretsManager(): SecretsManager {
  if (!cachedManager) cachedManager = createManager();
  return cachedManager;
}

export function sharedVault(): Vault {
  return sharedSecretsManager().vault;
}

/**
 * Test-only: drop the cached vault so the next `sharedVault()` call
 * re-initializes from the (possibly newly configured) environment.
 * Also lets tests inject a test vault built via `createTestVault`.
 */
export function _resetSharedVaultForTesting(next: Vault | null = null): void {
  cachedManager = next ? createManager({ vault: next }) : null;
}

/**
 * Write-through mirror to @elizaos/vault. Iterates the plugin's
 * declared parameters, finds sensitive ones, and writes whatever
 * value the user just submitted into the vault as a sensitive entry.
 *
 * Returns the list of keys that failed to write. The PUT handler
 * surfaces them under `vaultMirrorFailures` in the response so the UI
 * can warn the user that their secret was saved to legacy config but
 * not mirrored to the vault. Per-key try/catch keeps one failed key
 * from aborting the rest of the loop.
 *
 * Vault key shape: the env-var name itself (e.g.
 * `OPENROUTER_API_KEY`). Stable, matches what the legacy code uses,
 * and lets the read-side hydration round-trip cleanly.
 */
export async function mirrorPluginSensitiveToVault(
  plugin: { parameters: Array<{ key: string; sensitive: boolean }> },
  body: unknown,
): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  const config = (asRecord(body) as { config?: unknown })?.config;
  const configRecord = asRecord(config);
  if (!configRecord) return { failures };
  const sensitiveKeys = plugin.parameters
    .filter((p) => p.sensitive)
    .map((p) => p.key);
  if (sensitiveKeys.length === 0) return { failures };
  const manager = sharedSecretsManager();
  for (const key of sensitiveKeys) {
    const value = configRecord[key];
    if (typeof value !== "string") continue;
    try {
      if (value.length === 0) {
        await manager.remove(key);
      } else {
        await manager.set(key, value, {
          sensitive: true,
          caller: "plugins-compat",
        });
      }
    } catch (err) {
      failures.push(key);
      logger.warn(
        `[plugins-compat] vault mirror for ${key} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { failures };
}
