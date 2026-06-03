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

// Cache for the lazily-created process-wide SecretsManager facade.
//
// TDZ-hardening: this module sits in a circular-import chain that runs through
// vault-bootstrap.ts → loadRegistry (../registry) → … → back into app-core,
// which on Bun's strict ESM evaluator can re-enter `sharedSecretsManager()`
// before the top-level initializer of `vault-mirror.ts` finishes running. A
// bare `let cachedManager = null` would be in the temporal dead zone at that
// moment and throw `Cannot access 'cachedManager' before initialization`,
// which surfaced at boot as `[vault-bootstrap]` failing and the agent never
// binding to port 31337 (live-USB symptom). A module-level `let` of a
// container object dodges TDZ because the container is hoisted with its
// `undefined` initializer in the var-environment phase, and the only access
// path goes through `state.manager` which is just an object property read.
var state: { manager: SecretsManager | null } = { manager: null };

export function sharedSecretsManager(): SecretsManager {
  // Self-heal: if a circular import re-entered us before the module-top
  // `var state = {…}` initializer line ran, hoisted `state` is still
  // `undefined`. Lazily initialize the container so we never throw and
  // downstream callers see a stable `{ manager: null }` after first access.
  // Defensive: the primary fix is breaking the cycle (see
  // `vault-bootstrap.ts` agent-bridge lazy import), but this guard keeps
  // cycle regressions from silently bricking boot.
  if (!state) {
    state = { manager: null };
  }
  if (!state.manager) state.manager = createManager();
  return state.manager;
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
  state.manager = next ? createManager({ vault: next }) : null;
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
