/**
 * Write-through mirror to @elizaos/vault for plugin sensitive fields.
 *
 * Extracted from plugins-compat-routes.ts so unit tests can exercise the
 * mirror logic without dragging in the entire @elizaos/agent runtime.
 *
 * Concurrency: the vault PUT path is hit concurrently when the UI saves
 * multiple plugin configs in parallel. `VaultImpl.mutate()` serializes
 * writes via a per-instance mutex chained on `this.mutex`. That mutex
 * only protects calls that share the same instance — if every request
 * constructs a fresh `createVault()`, two parallel saves of different
 * keys can each read `vault.json`, then race the write, and one set of
 * entries is silently lost.
 *
 * We cache one vault per process so the mutex actually applies. This
 * is the inverse of the no-cache pattern in `secrets-manager-routes.ts`
 * (which intentionally re-creates per request because that route is
 * only called from a single user opening the modal — no concurrency).
 */

import { logger } from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
import { createVault, type Vault } from "@elizaos/vault";

let cachedVault: Vault | null = null;

export function sharedVault(): Vault {
  if (!cachedVault) cachedVault = createVault();
  return cachedVault;
}

/**
 * Test-only: drop the cached vault so the next `sharedVault()` call
 * re-initializes from the (possibly newly configured) environment.
 * Also lets tests inject a test vault built via `createTestVault`.
 */
export function _resetSharedVaultForTesting(next: Vault | null = null): void {
  cachedVault = next;
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
  const vault = sharedVault();
  for (const key of sensitiveKeys) {
    const value = configRecord[key];
    if (typeof value !== "string" || value.length === 0) continue;
    try {
      await vault.set(key, value, { sensitive: true });
    } catch (err) {
      failures.push(key);
      logger.warn(
        `[plugins-compat] vault.set(${key}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { failures };
}
