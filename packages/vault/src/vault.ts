/**
 * Vault factory wired to the default PGlite storage engine and master key.
 *
 * Resolves the elizaOS state directory, audit log path, legacy JSON store, and
 * default master-key resolver before constructing the vault implementation.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { defaultMasterKey } from "./master-key.js";
import { PgliteVaultImpl } from "./pglite-vault.js";
import type { CreateVaultOptions, Vault } from "./vault-types.js";

export type { CreateVaultOptions, SetOptions, Vault } from "./vault-types.js";
export { VaultMissError } from "./vault-types.js";

/**
 * Resolve the state-directory root the default vault lives under
 * (ELIZA_STATE_DIR / XDG_STATE_HOME / ~/.local/state/<namespace>), shared by
 * vault construction and the data-dir probe so the two can never drift.
 */
function resolveDefaultVaultRoot(workDir?: string): string {
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  return (
    workDir ??
    process.env.ELIZA_STATE_DIR?.trim() ??
    (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), namespace)
      : join(homedir(), ".local", "state", namespace))
  );
}

/**
 * The PGlite data directory the default (no-options) vault opens. Exposed so
 * boot paths can cheaply test whether a vault exists on disk — a missing dir
 * is provably an empty vault (no profiles, no stored secrets), letting them
 * skip vault reads without paying the PGlite cold start a probing query would
 * trigger.
 */
export function resolveDefaultVaultDataDir(): string {
  return join(resolveDefaultVaultRoot(), ".vault-pglite");
}

/**
 * Create a vault backed by PGlite. On first construction when the table is
 * empty, migrates any entries from the legacy `vault.json` file.
 */
export function createVault(opts: CreateVaultOptions = {}): Vault {
  const root = resolveDefaultVaultRoot(opts.workDir);
  const storePath = join(root, "vault.json");
  const auditPath = join(root, "audit", "vault.jsonl");
  const masterKey = opts.masterKey ?? defaultMasterKey();

  return new PgliteVaultImpl({
    dataDir: join(root, ".vault-pglite"),
    legacyStorePath: storePath,
    masterKey,
    auditPath,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
