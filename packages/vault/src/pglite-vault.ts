import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AuditLog } from "./audit.js";
import { decrypt, encrypt } from "./crypto.js";
import { assertKey, optsCaller } from "./internal-utils.js";
import type { MasterKeyResolver } from "./master-key.js";
import { resolveReference } from "./password-managers.js";
import { emptyStore, readStore, type StoreData } from "./store.js";
import type {
  PasswordManagerReference,
  StoredEntry,
  VaultDescriptor,
  VaultLogger,
  VaultStats,
} from "./types.js";
import type { SetOptions, Vault } from "./vault-types.js";
import { VaultMissError } from "./vault-types.js";

/**
 * PGlite-backed Vault implementation.
 *
 * The vault gets its OWN PGlite database at `<stateDir>/.vault-pglite/`,
 * separate from the runtime DB at `<stateDir>/.elizadb/`. This:
 *   - sidesteps PGlite's single-writer constraint (vault doesn't share a
 *     connection with plugin-sql)
 *   - lets the vault open at startEliza step 2e, well before plugin-sql
 *     registers at step 7b — no ordering contortions
 *   - keeps vault corruption isolated from chat/memory corruption
 *
 * Crypto + master-key flow are unchanged from VaultImpl: AES-256-GCM with
 * the key as AAD, master key from OS Keychain via `@napi-rs/keyring`. The
 * DB stores opaque ciphertext; PGlite never sees plaintext or the master
 * key.
 *
 * The schema is one table. No Drizzle, no migrator framework. Schema
 * changes are additive ALTER TABLE blocks in `ensureSchema()`.
 */

const SCHEMA_SETUP = `
  CREATE TABLE IF NOT EXISTS vault_entries (
    key            TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    value          TEXT,
    ciphertext     TEXT,
    ref_source     TEXT,
    ref_path       TEXT,
    last_modified  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vault_entries_kind ON vault_entries(kind);
`;

const MIGRATION_SENTINEL_KEY = "_migrated_from_file_v1";

interface EntryRow {
  key: string;
  kind: "value" | "secret" | "reference";
  value: string | null;
  ciphertext: string | null;
  ref_source: string | null;
  ref_path: string | null;
  last_modified: string | number;
}

export interface PgliteVaultOptions {
  /** Data directory for the vault PGlite. Default: `<stateDir>/.vault-pglite/`. */
  readonly dataDir?: string;
  /** Path to the legacy vault.json file for one-shot migration. */
  readonly legacyStorePath?: string;
  /** Master key resolver. Crypto path is identical to VaultImpl. */
  readonly masterKey: MasterKeyResolver;
  /** Audit log path. Default: `<stateDir>/audit/vault.jsonl`. */
  readonly auditPath: string;
  /** Optional logger for non-fatal warnings. */
  readonly logger?: VaultLogger;
}

export class PgliteVaultImpl implements Vault {
  private cachedKey: Buffer | null = null;
  private dbPromise: Promise<PGlite> | null = null;
  private readonly audit: AuditLog;

  constructor(private readonly opts: PgliteVaultOptions) {
    this.audit = new AuditLog(opts.auditPath, opts.logger);
  }

  async set(key: string, value: string, opts: SetOptions = {}): Promise<void> {
    assertKey(key);
    if (typeof value !== "string") {
      throw new TypeError("vault.set: value must be a string");
    }
    const db = await this.db();
    const lastModified = Date.now();
    if (opts.sensitive) {
      const masterKey = await this.loadMasterKey();
      const ciphertext = encrypt(masterKey, value, key);
      await db.query(
        `INSERT INTO vault_entries (key, kind, ciphertext, last_modified)
         VALUES ($1, 'secret', $2, $3)
         ON CONFLICT (key) DO UPDATE SET
           kind = EXCLUDED.kind,
           value = NULL,
           ciphertext = EXCLUDED.ciphertext,
           ref_source = NULL,
           ref_path = NULL,
           last_modified = EXCLUDED.last_modified`,
        [key, ciphertext, lastModified],
      );
    } else {
      await db.query(
        `INSERT INTO vault_entries (key, kind, value, last_modified)
         VALUES ($1, 'value', $2, $3)
         ON CONFLICT (key) DO UPDATE SET
           kind = EXCLUDED.kind,
           value = EXCLUDED.value,
           ciphertext = NULL,
           ref_source = NULL,
           ref_path = NULL,
           last_modified = EXCLUDED.last_modified`,
        [key, value, lastModified],
      );
    }
    await this.audit.record({ action: "set", key, ...optsCaller(opts) });
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
    const db = await this.db();
    const lastModified = Date.now();
    await db.query(
      `INSERT INTO vault_entries (key, kind, ref_source, ref_path, last_modified)
       VALUES ($1, 'reference', $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         kind = EXCLUDED.kind,
         value = NULL,
         ciphertext = NULL,
         ref_source = EXCLUDED.ref_source,
         ref_path = EXCLUDED.ref_path,
         last_modified = EXCLUDED.last_modified`,
      [key, ref.source, ref.path, lastModified],
    );
    await this.audit.record({ action: "setReference", key });
  }

  async get(key: string): Promise<string> {
    assertKey(key);
    const value = await this.readValue(key);
    await this.audit.record({ action: "get", key });
    return value;
  }

  async reveal(key: string, caller?: string): Promise<string> {
    assertKey(key);
    const value = await this.readValue(key);
    await this.audit.record({
      action: "reveal",
      key,
      ...(caller ? { caller } : {}),
    });
    return value;
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    const db = await this.db();
    const res = await db.query<{ exists: boolean }>(
      `SELECT 1 AS exists FROM vault_entries WHERE key = $1 LIMIT 1`,
      [key],
    );
    return res.rows.length > 0;
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    const db = await this.db();
    await db.query(`DELETE FROM vault_entries WHERE key = $1`, [key]);
    await this.audit.record({ action: "remove", key });
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const db = await this.db();
    if (!prefix) {
      const res = await db.query<{ key: string }>(
        `SELECT key FROM vault_entries WHERE key <> $1 ORDER BY key`,
        [MIGRATION_SENTINEL_KEY],
      );
      return res.rows.map((r) => r.key);
    }
    // Prefix match as a *segment* (matches `prefix` exactly or `prefix.<rest>`),
    // mirroring VaultImpl's `k === prefix || k.startsWith(prefix + ".")`.
    // SQL `LIKE` treats `_` as a single-character wildcard and `%` as
    // multi-character. Vault keys regularly contain underscores
    // (e.g. `ELIZAOS_CLOUD_API_KEY`), so the prefix has to be escaped or
    // `list("ELIZAOS_CLOUD")` returns unrelated keys like
    // `ELIZAOSXCLOUD.foo`. Use an explicit ESCAPE clause.
    const escapedPrefix = prefix.replace(/[\\%_]/g, "\\$&");
    const res = await db.query<{ key: string }>(
      `SELECT key FROM vault_entries
       WHERE key <> $3 AND (key = $1 OR key LIKE $2 ESCAPE '\\')
       ORDER BY key`,
      [prefix, `${escapedPrefix}.%`, MIGRATION_SENTINEL_KEY],
    );
    return res.rows.map((r) => r.key);
  }

  async describe(key: string): Promise<VaultDescriptor | null> {
    assertKey(key);
    const db = await this.db();
    const res = await db.query<EntryRow>(
      `SELECT key, kind, value, ciphertext, ref_source, ref_path, last_modified
         FROM vault_entries WHERE key = $1 LIMIT 1`,
      [key],
    );
    const row = res.rows[0];
    if (!row) return null;
    const lastModified = toMillis(row.last_modified);
    if (row.kind === "value") {
      return { key, source: "file", sensitive: false, lastModified };
    }
    if (row.kind === "secret") {
      return {
        key,
        source: "keychain-encrypted",
        sensitive: true,
        lastModified,
      };
    }
    return {
      key,
      source: (row.ref_source ?? "1password") as "1password" | "protonpass",
      sensitive: true,
      lastModified,
    };
  }

  async stats(): Promise<VaultStats> {
    const db = await this.db();
    const res = await db.query<{ kind: string; n: string | number }>(
      `SELECT kind, COUNT(*) AS n
         FROM vault_entries
        WHERE key <> $1
        GROUP BY kind`,
      [MIGRATION_SENTINEL_KEY],
    );
    let sensitive = 0;
    let nonSensitive = 0;
    let references = 0;
    for (const row of res.rows) {
      const n = typeof row.n === "string" ? Number.parseInt(row.n, 10) : row.n;
      if (row.kind === "value") nonSensitive += n;
      else if (row.kind === "secret") sensitive += n;
      else if (row.kind === "reference") references += n;
    }
    return {
      total: sensitive + nonSensitive + references,
      sensitive,
      nonSensitive,
      references,
    };
  }

  /** Close the underlying PGlite connection. Tests + graceful shutdown only. */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    this.dbPromise = null;
    await db.close();
  }

  // ── internals ────────────────────────────────────────────────────────

  private async readValue(key: string): Promise<string> {
    const db = await this.db();
    const res = await db.query<EntryRow>(
      `SELECT key, kind, value, ciphertext, ref_source, ref_path
         FROM vault_entries WHERE key = $1 LIMIT 1`,
      [key],
    );
    const row = res.rows[0];
    if (!row) throw new VaultMissError(key);
    if (row.kind === "value") {
      if (row.value == null) {
        throw new Error(
          `vault: corrupt entry ${key}: kind=value but value=null`,
        );
      }
      return row.value;
    }
    if (row.kind === "secret") {
      if (row.ciphertext == null) {
        throw new Error(
          `vault: corrupt entry ${key}: kind=secret but ciphertext=null`,
        );
      }
      const masterKey = await this.loadMasterKey();
      return decrypt(masterKey, row.ciphertext, key);
    }
    if (row.ref_source == null || row.ref_path == null) {
      throw new Error(
        `vault: corrupt reference entry ${key}: missing source or path`,
      );
    }
    return resolveReference({
      source: row.ref_source as PasswordManagerReference["source"],
      path: row.ref_path,
    });
  }

  private async loadMasterKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = await this.opts.masterKey.load();
    return this.cachedKey;
  }

  private async db(): Promise<PGlite> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDb();
    }
    return this.dbPromise;
  }

  private async openDb(): Promise<PGlite> {
    const dataDir = this.opts.dataDir ?? defaultPgliteVaultDataDir();
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = await PGlite.create(dataDir);
    await db.exec(SCHEMA_SETUP);
    if (this.opts.legacyStorePath) {
      await this.maybeMigrateFromFile(db, this.opts.legacyStorePath);
    }
    return db;
  }

  /**
   * One-shot migration from `vault.json` → vault_entries. Runs on first
   * PgliteVaultImpl boot when the table is empty AND the legacy file
   * exists. Copies entries verbatim — ciphertext stays opaque, master
   * key unchanged. Writes a sentinel row so we never re-run.
   *
   * The legacy file is left in place for one release as a safety net. A
   * follow-up release deletes both the file and this migration code.
   */
  private async maybeMigrateFromFile(
    db: PGlite,
    legacyPath: string,
  ): Promise<void> {
    // Cheap: only proceed if the table is empty.
    const countRes = await db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM vault_entries`,
    );
    const existing = countRes.rows[0]?.n;
    const hasRows =
      typeof existing === "string"
        ? Number.parseInt(existing, 10) > 0
        : (existing ?? 0) > 0;
    if (hasRows) return;

    let store: StoreData;
    try {
      store = await readStore(legacyPath);
    } catch (err) {
      this.opts.logger?.warn(
        `[vault] failed to read legacy vault.json for migration; PGlite vault starts empty`,
        err,
      );
      // Still write the sentinel — without it every subsequent boot
      // re-reads the file (which keeps failing) and re-logs the warning.
      await writeMigrationSentinel(db, "read-failed");
      return;
    }
    const keys = Object.keys(store.entries);
    if (keys.length === 0) {
      // Same reason as the read-failed path: without the sentinel, every
      // subsequent boot re-reads the empty legacy file.
      await writeMigrationSentinel(db, "empty-source");
      return;
    }

    let migrated = 0;
    await db.transaction(async (tx) => {
      for (const [key, entry] of Object.entries(store.entries)) {
        await insertLegacyEntry(tx, key, entry);
        migrated += 1;
      }
      await tx.query(
        `INSERT INTO vault_entries (key, kind, value, last_modified)
         VALUES ($1, 'value', $2, $3)
         ON CONFLICT (key) DO NOTHING`,
        [
          MIGRATION_SENTINEL_KEY,
          JSON.stringify({ at: new Date().toISOString(), migrated }),
          Date.now(),
        ],
      );
    });
    this.opts.logger?.warn(
      `[vault] migrated ${migrated} entries from ${legacyPath} to PGlite. Legacy file retained as safety net.`,
    );
  }
}

/**
 * Write the migration sentinel without any legacy entries. Called from the
 * read-failed and empty-source paths so the COUNT(*) check on the next boot
 * sees a non-empty table and short-circuits — avoiding repeated readStore
 * I/O and repeated warning spam from the read-failed branch.
 *
 * The reason field surfaces in `describe("_migrated_from_file_v1")` for
 * post-mortem if migration ever needs investigating.
 */
async function writeMigrationSentinel(
  db: PGlite,
  reason: "read-failed" | "empty-source",
): Promise<void> {
  await db.query(
    `INSERT INTO vault_entries (key, kind, value, last_modified)
     VALUES ($1, 'value', $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [
      MIGRATION_SENTINEL_KEY,
      JSON.stringify({ at: new Date().toISOString(), reason, migrated: 0 }),
      Date.now(),
    ],
  );
}

async function insertLegacyEntry(
  tx: { query: PGlite["query"] },
  key: string,
  entry: StoredEntry,
): Promise<void> {
  if (entry.kind === "value") {
    await tx.query(
      `INSERT INTO vault_entries (key, kind, value, last_modified)
       VALUES ($1, 'value', $2, $3) ON CONFLICT (key) DO NOTHING`,
      [key, entry.value, entry.lastModified],
    );
    return;
  }
  if (entry.kind === "secret") {
    await tx.query(
      `INSERT INTO vault_entries (key, kind, ciphertext, last_modified)
       VALUES ($1, 'secret', $2, $3) ON CONFLICT (key) DO NOTHING`,
      [key, entry.ciphertext, entry.lastModified],
    );
    return;
  }
  await tx.query(
    `INSERT INTO vault_entries (key, kind, ref_source, ref_path, last_modified)
     VALUES ($1, 'reference', $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
    [key, entry.source, entry.path, entry.lastModified],
  );
}

export function defaultPgliteVaultDataDir(): string {
  const root =
    process.env.ELIZA_STATE_DIR?.trim() ??
    process.env.MILADY_STATE_DIR?.trim() ??
    join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`);
  return join(root, ".vault-pglite");
}

function toMillis(value: string | number): number {
  if (typeof value === "number") return value;
  return Number.parseInt(value, 10);
}

// Re-export emptyStore for callers that previously imported it via vault.ts.
export { emptyStore };
