import type { MasterKeyResolver } from "./master-key.js";
import type {
  PasswordManagerReference,
  VaultDescriptor,
  VaultLogger,
  VaultStats,
} from "./types.js";

export interface Vault {
  /** Store a value. Sensitive values are encrypted at rest. */
  set(key: string, value: string, opts?: SetOptions): Promise<void>;

  /**
   * Store a reference to a password-manager item. The actual value
   * lives there, never copied to disk by this vault.
   */
  setReference(key: string, ref: PasswordManagerReference): Promise<void>;

  /** Read a value. Resolves through the password manager if needed. */
  get(key: string): Promise<string>;

  /**
   * Read with audit trail. Use this for "show / reveal" UI affordances
   * — every reveal is recorded with the caller id so users can see who
   * read what.
   */
  reveal(key: string, caller?: string): Promise<string>;

  /** Existence check. Does NOT reveal the value. */
  has(key: string): Promise<boolean>;

  /** Remove. Idempotent. */
  remove(key: string): Promise<void>;

  /** List keys. Optional prefix filter. Does NOT reveal values. */
  list(prefix?: string): Promise<readonly string[]>;

  /** Describe a key without revealing it. */
  describe(key: string): Promise<VaultDescriptor | null>;

  /** Aggregate counts. */
  stats(): Promise<VaultStats>;
}

export interface SetOptions {
  /** True if the value is a credential. Sensitive values are encrypted. */
  readonly sensitive?: boolean;
  /** Optional caller id for the audit log. */
  readonly caller?: string;
}

export interface CreateVaultOptions {
  /**
   * Working directory. Resolution order (first non-empty wins):
   *
   *   1. `opts.workDir` — explicit caller override (tests, embedded use).
   *   2. `$ELIZA_STATE_DIR` — Eliza's state-dir override.
   *   3. `$ELIZA_STATE_DIR` — elizaOS-compatible state-dir override.
   *   4. `~/$ELIZA_NAMESPACE` with a leading dot (`~/.eliza` by default).
   *
   * The vault writes `vault.json` and `audit/vault.jsonl` inside the
   * resolved directory.
   */
  readonly workDir?: string;
  /**
   * Master key resolver. Default: OS keychain via `@napi-rs/keyring`.
   * Override with `inMemoryMasterKey(buffer)` for tests.
   */
  readonly masterKey?: MasterKeyResolver;
  /** Optional logger for non-fatal warnings. */
  readonly logger?: VaultLogger;
}

export class VaultMissError extends Error {
  constructor(readonly key: string) {
    super(`vault: no entry for ${JSON.stringify(key)}`);
    this.name = "VaultMissError";
  }
}
