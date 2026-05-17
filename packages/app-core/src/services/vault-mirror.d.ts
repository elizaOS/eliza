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
import { type SecretsManager, type Vault } from "@elizaos/vault";
export declare function sharedSecretsManager(): SecretsManager;
export declare function sharedVault(): Vault;
/**
 * Test-only: drop the cached vault so the next `sharedVault()` call
 * re-initializes from the (possibly newly configured) environment.
 * Also lets tests inject a test vault built via `createTestVault`.
 */
export declare function _resetSharedVaultForTesting(next?: Vault | null): void;
/**
 * Write-through mirror to @elizaos/vault. Iterates the plugin's
 * declared parameters, finds sensitive ones, and writes whatever
 * value the user just submitted into the vault as a sensitive entry.
 *
 * Returns the list of keys that failed to write. The PUT handler
 * surfaces them under `vaultMirrorFailures` in the response so the UI
 * can warn the user that the vault mirror did not take. Per-key
 * try/catch keeps one failed key from aborting the rest of the loop.
 *
 * Vault key shape: the env-var name itself (e.g. `OPENROUTER_API_KEY`),
 * matching the read-side hydration path.
 */
export declare function mirrorPluginSensitiveToVault(
  plugin: {
    parameters: Array<{
      key: string;
      sensitive: boolean;
    }>;
  },
  body: unknown,
): Promise<{
  failures: string[];
}>;
//# sourceMappingURL=vault-mirror.d.ts.map
