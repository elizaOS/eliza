import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { decrypt, encrypt } from "./crypto.js";
import { assertKey, optsCaller } from "./internal-utils.js";
import { defaultMasterKey, type MasterKeyResolver } from "./master-key.js";
import { resolveReference } from "./password-managers.js";
import { PgliteVaultImpl } from "./pglite-vault.js";
import {
  readStore,
  removeEntry,
  type StoreData,
  setEntry,
  writeStore,
} from "./store.js";
import type {
  AuditRecord,
  PasswordManagerReference,
  VaultDescriptor,
  VaultLogger,
  VaultStats,
} from "./types.js";
import type { CreateVaultOptions, SetOptions, Vault } from "./vault-types.js";
import { VaultMissError } from "./vault-types.js";

export type { CreateVaultOptions, SetOptions, Vault } from "./vault-types.js";
export { VaultMissError } from "./vault-types.js";

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
export function createVault(opts: CreateVaultOptions = {}): Vault {
  const root =
    opts.workDir ??
    process.env.ELIZA_STATE_DIR?.trim() ??
    process.env.MILADY_STATE_DIR?.trim() ??
    join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`);
  const storePath = join(root, "vault.json");
  const auditPath = join(root, "audit", "vault.jsonl");
  const masterKey = opts.masterKey ?? defaultMasterKey();

  // Backend selection. Default: PGlite (consolidates state into the same
  // database surface used by conversations/plugins). Set
<<<<<<< HEAD
  // `ELIZA_VAULT_BACKEND=file` (or legacy `MILADY_VAULT_BACKEND=file`) to
=======
  // `ELIZA_VAULT_BACKEND=file` (or legacy `ELIZA_VAULT_BACKEND=file`) to
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  // keep the legacy file-backed VaultImpl. The PGlite backend
  // automatically migrates from `vault.json` on first construction if the
  // table is empty and the file exists; legacy file is retained one
  // release as a safety net.
  const backend = (
<<<<<<< HEAD
=======
    process.env.ELIZA_VAULT_BACKEND ??
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
    process.env.ELIZA_VAULT_BACKEND ??
    process.env.MILADY_VAULT_BACKEND ??
    "pglite"
  ).toLowerCase();
  if (backend === "file" || backend === "json") {
    return new VaultImpl(storePath, auditPath, masterKey, opts.logger);
  }
  return new PgliteVaultImpl({
    dataDir: join(root, ".vault-pglite"),
    legacyStorePath: storePath,
    masterKey,
    auditPath,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

class VaultImpl implements Vault {
  private cachedKey: Buffer | null = null;
  private mutex: Promise<void> = Promise.resolve();
  private readonly audit: AuditLog;

  constructor(
    private readonly storePath: string,
    auditPath: string,
    private readonly masterKey: MasterKeyResolver,
    logger?: VaultLogger,
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
    if (ref.path.trim().length === 0) {
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
    // Match the prefix as a *segment*, not a substring: `"ui"` should
    // match `ui` and `ui.theme` but not `ui_legacy_thing` or `uib`.
    return keys.filter((k) => k === prefix || k.startsWith(`${prefix}.`));
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
    return readStore(this.storePath);
  }

  private async loadMasterKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = await this.masterKey.load();
    return this.cachedKey;
  }

  private async mutate(mutator: (s: StoreData) => StoreData): Promise<void> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await withStoreMutationLock(this.storePath, async () => {
        const current = await readStore(this.storePath);
        const next = mutator(current);
        await writeStore(this.storePath, next);
      });
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

// re-exports for ergonomic imports
export { emptyStore } from "./store.js";

const PROCESS_STORE_LOCKS = new Map<string, Promise<void>>();

async function withStoreMutationLock<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(storePath);
  const previous = PROCESS_STORE_LOCKS.get(key) ?? Promise.resolve();
  let releaseProcessLock!: () => void;
  const current = new Promise<void>((resolveLock) => {
    releaseProcessLock = resolveLock;
  });
  const chained = previous.then(
    () => current,
    () => current,
  );
  PROCESS_STORE_LOCKS.set(key, chained);
  await previous;

  const lockDir = `${key}.lock`;
  await fs.mkdir(dirname(lockDir), { recursive: true });
  let lockAcquired = false;
  try {
    await acquireFsLock(lockDir);
    lockAcquired = true;
    return await fn();
  } finally {
    if (lockAcquired) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
    releaseProcessLock();
    if (PROCESS_STORE_LOCKS.get(key) === chained) {
      PROCESS_STORE_LOCKS.delete(key);
    }
  }
}

async function acquireFsLock(lockDir: string): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`vault store lock timed out: ${lockDir}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}
