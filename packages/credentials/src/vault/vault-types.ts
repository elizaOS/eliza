/**
 * Core vault API types shared by factories, managers, and storage engines.
 */

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

  /** Atomically store a value only when the key does not already exist. */
  setIfAbsent(key: string, value: string, opts?: SetOptions): Promise<boolean>;

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

  /**
   * Move an unreadable entry out of the active keyspace without decrypting or
   * deleting its stored bytes. This is a narrow recovery primitive for callers
   * that already observed {@link VaultDecryptionError}. The opaque entry
   * identity from that exact failure is a compare-and-swap guard: a stale
   * caller cannot quarantine a replacement written by another process. The
   * quarantined row is retained in the vault database for forensic/manual
   * recovery.
   */
  quarantineUnreadable(
    key: string,
    expectedEntryIdentity: string,
    reason: string,
    caller?: string,
  ): Promise<boolean>;

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
   *   3. `$XDG_STATE_HOME/$ELIZA_NAMESPACE`.
   *   4. `~/.local/state/$ELIZA_NAMESPACE`.
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

/** A stored secret exists but cannot be authenticated with the active key. */
export class VaultDecryptionError extends Error {
  /** Opaque identity of the exact persisted row that failed authentication. */
  readonly entryIdentity: string | undefined;

  constructor(
    readonly key: string,
    options?: ErrorOptions & { readonly entryIdentity?: string },
  ) {
    super(
      `vault: failed to decrypt ${JSON.stringify(key)} (wrong master key or corrupt ciphertext)`,
      options,
    );
    this.name = "VaultDecryptionError";
    this.entryIdentity = options?.entryIdentity;
  }
}
