import { homedir } from "node:os";
import { join } from "node:path";
import { decrypt, encrypt } from "./crypto.js";
import {
  type MasterKeyResolver,
  osKeychainMasterKey,
} from "./master-key.js";
import { resolveReference } from "./password-managers.js";
import {
  emptyStore,
  readStore,
  removeEntry,
  setEntry,
  type StoreData,
  writeStore,
} from "./store.js";
import { AuditLog } from "./audit.js";
import type {
  AuditRecord,
  PasswordManagerReference,
  StoredEntry,
  VaultDescriptor,
  VaultLogger,
  VaultStats,
} from "./types.js";

/**
 * Simple secrets/config vault.
 *
 * One API serves both sensitive credentials and non-sensitive config:
 *   await vault.set("openrouter.apiKey", "sk-or-...", { sensitive: true });
 *   await vault.set("ui.theme", "dark");
 *   const v = await vault.get("openrouter.apiKey");
 *
 * Sensitive values are AES-256-GCM encrypted with the vault key as AAD;
 * the master key lives in the OS keychain. Non-sensitive values are
 * stored plaintext in `vault.json` (mode 0600). References to external
 * password managers (1Password, Proton Pass) are first-class — the
 * vault stores only the reference and resolves at use time.
 */
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
   * Working directory. Default: `$MILADY_STATE_DIR` if set, else
   * `~/.milady`. The vault writes `vault.json` and `audit/vault.jsonl`
   * inside it.
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

export function createVault(opts: CreateVaultOptions = {}): Vault {
  const root =
    opts.workDir ??
    process.env.MILADY_STATE_DIR ??
    process.env.ELIZA_STATE_DIR ??
    join(homedir(), ".milady");
  const storePath = join(root, "vault.json");
  const auditPath = join(root, "audit", "vault.jsonl");
  const masterKey = opts.masterKey ?? osKeychainMasterKey();
  return new VaultImpl(storePath, auditPath, masterKey, opts.logger);
}

class VaultImpl implements Vault {
  private cachedStore: StoreData | null = null;
  private cachedKey: Buffer | null = null;
  private mutex: Promise<void> = Promise.resolve();
  private readonly audit: AuditLog;

  constructor(
    private readonly storePath: string,
    private readonly auditPath: string,
    private readonly masterKey: MasterKeyResolver,
    private readonly logger?: VaultLogger,
  ) {
    this.audit = new AuditLog(auditPath, logger);
  }

  async set(key: string, value: string, opts: SetOptions = {}): Promise<void> {
    assertKey(key);
    if (typeof value !== "string") {
      throw new TypeError("vault.set: value must be a string");
    }
    if (opts.sensitive) {
      const masterKey = await this.loadMasterKey();
      const ciphertext = encrypt(masterKey, value, key);
      await this.mutate((s) =>
        setEntry(s, key, {
          kind: "secret",
          ciphertext,
          lastModified: Date.now(),
        }),
      );
    } else {
      await this.mutate((s) =>
        setEntry(s, key, {
          kind: "value",
          value,
          lastModified: Date.now(),
        }),
      );
    }
    await this.recordAudit({ action: "set", key, ...optsCaller(opts) });
  }

  async setReference(
    key: string,
    ref: PasswordManagerReference,
  ): Promise<void> {
    assertKey(key);
    if (ref.source !== "1password" && ref.source !== "protonpass") {
      throw new TypeError(`unsupported password manager: ${ref.source}`);
    }
    if (!ref.path || ref.path.trim().length === 0) {
      throw new TypeError("setReference: path required");
    }
    await this.mutate((s) =>
      setEntry(s, key, {
        kind: "reference",
        source: ref.source,
        path: ref.path,
        lastModified: Date.now(),
      }),
    );
    await this.recordAudit({ action: "setReference", key });
  }

  async get(key: string): Promise<string> {
    assertKey(key);
    const value = await this.readValue(key);
    await this.recordAudit({ action: "get", key });
    return value;
  }

  async reveal(key: string, caller?: string): Promise<string> {
    assertKey(key);
    const value = await this.readValue(key);
    await this.recordAudit({
      action: "reveal",
      key,
      ...(caller ? { caller } : {}),
    });
    return value;
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    const store = await this.loadStore();
    return key in store.entries;
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    await this.mutate((s) => removeEntry(s, key));
    await this.recordAudit({ action: "remove", key });
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const store = await this.loadStore();
    const keys = Object.keys(store.entries);
    if (!prefix) return keys;
    return keys.filter((k) => k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(prefix));
  }

  async describe(key: string): Promise<VaultDescriptor | null> {
    assertKey(key);
    const store = await this.loadStore();
    const entry = store.entries[key];
    if (!entry) return null;
    if (entry.kind === "value") {
      return {
        key,
        source: "file",
        sensitive: false,
        lastModified: entry.lastModified,
      };
    }
    if (entry.kind === "secret") {
      return {
        key,
        source: "keychain-encrypted",
        sensitive: true,
        lastModified: entry.lastModified,
      };
    }
    return {
      key,
      source: entry.source,
      sensitive: true,
      lastModified: entry.lastModified,
    };
  }

  async stats(): Promise<VaultStats> {
    const store = await this.loadStore();
    let sensitive = 0;
    let nonSensitive = 0;
    let references = 0;
    for (const e of Object.values(store.entries)) {
      if (e.kind === "value") nonSensitive += 1;
      else if (e.kind === "secret") sensitive += 1;
      else references += 1;
    }
    return {
      total: sensitive + nonSensitive + references,
      sensitive,
      nonSensitive,
      references,
    };
  }

  // ── internals ───────────────────────────────────────────────────

  private async readValue(key: string): Promise<string> {
    const store = await this.loadStore();
    const entry = store.entries[key];
    if (!entry) throw new VaultMissError(key);
    if (entry.kind === "value") return entry.value;
    if (entry.kind === "secret") {
      const masterKey = await this.loadMasterKey();
      return decrypt(masterKey, entry.ciphertext, key);
    }
    return resolveReference({ source: entry.source, path: entry.path });
  }

  private async loadStore(): Promise<StoreData> {
    if (this.cachedStore) return this.cachedStore;
    this.cachedStore = await readStore(this.storePath);
    return this.cachedStore;
  }

  private async loadMasterKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = await this.masterKey.load();
    return this.cachedKey;
  }

  private async mutate(
    mutator: (s: StoreData) => StoreData,
  ): Promise<void> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const current = await this.loadStore();
      const next = mutator(current);
      await writeStore(this.storePath, next);
      this.cachedStore = next;
    } finally {
      release();
    }
  }

  private async recordAudit(
    entry: Omit<AuditRecord, "ts"> & { ts?: number },
  ): Promise<void> {
    await this.audit.record(entry);
  }
}

export class VaultMissError extends Error {
  constructor(readonly key: string) {
    super(`vault: no entry for ${JSON.stringify(key)}`);
    this.name = "VaultMissError";
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("vault: key must be a non-empty string");
  }
  if (key.length > 256) {
    throw new TypeError("vault: key must be 256 characters or fewer");
  }
}

function optsCaller(opts: SetOptions): { caller?: string } {
  return opts.caller ? { caller: opts.caller } : {};
}

// re-exports for ergonomic imports
export { emptyStore } from "./store.js";
