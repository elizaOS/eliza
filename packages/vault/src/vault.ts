import { homedir } from "node:os";
import { join } from "node:path";
import { defaultMasterKey } from "./master-key.js";
import { PgliteVaultImpl } from "./pglite-vault.js";
import type { CreateVaultOptions, Vault } from "./vault-types.js";

export type { CreateVaultOptions, SetOptions, Vault } from "./vault-types.js";
export { VaultMissError } from "./vault-types.js";

/**
 * Create a vault backed by PGlite. On first construction when the table is
 * empty, migrates any entries from the legacy `vault.json` file.
 */
export function createVault(opts: CreateVaultOptions = {}): Vault {
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const root =
    opts.workDir ??
    process.env.ELIZA_STATE_DIR?.trim() ??
    (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), namespace)
      : join(homedir(), ".local", "state", namespace));
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
