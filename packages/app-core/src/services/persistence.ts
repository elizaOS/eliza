/**
 * Mobile persistence adapter chain.
 *
 * Today the iOS shell persists state through `@capacitor/preferences` (which
 * is fine for tiny key-value blobs but pulls Apple's CFPreferences cache and
 * is not appropriate for non-trivial agent state — no transactions, awkward
 * for binary, capped at small payloads). This module introduces a real
 * `PersistenceAdapter` interface so the runtime can prefer SQLite when the
 * `@capacitor-community/sqlite` plugin is registered, and fall back to
 * Preferences when it isn't (e.g. older mobile shells that haven't shipped
 * the SQLite plugin yet, or web preview).
 *
 * Token storage MUST go through Keychain on iOS — handled by a separate
 * follow-up identified in the prior security review and intentionally NOT
 * touched here.
 */

import {
  type SqliteDatabase,
  isSqliteAvailable,
  openDatabase,
} from "../connectors/capacitor-sqlite.ts";

export interface PersistenceAdapter {
  readonly kind: "ios-preferences" | "ios-sqlite" | "web-localstorage";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Best-effort iteration; only required for migration. */
  keys(): Promise<string[]>;
}

/* ── iOS Preferences adapter ────────────────────────────────────────────── */

interface PreferencesPlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

class IosPreferencesAdapter implements PersistenceAdapter {
  readonly kind = "ios-preferences" as const;
  constructor(private readonly preferences: PreferencesPlugin) {}
  async get(key: string): Promise<string | null> {
    const result = await this.preferences.get({ key });
    return result.value;
  }
  async set(key: string, value: string): Promise<void> {
    await this.preferences.set({ key, value });
  }
  async remove(key: string): Promise<void> {
    await this.preferences.remove({ key });
  }
  async keys(): Promise<string[]> {
    const result = await this.preferences.keys();
    return result.keys;
  }
}

/* ── iOS SQLite adapter ─────────────────────────────────────────────────── */

const KV_TABLE_NAME = "eliza_kv";
const KV_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${KV_TABLE_NAME} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`;

class IosSqliteAdapter implements PersistenceAdapter {
  readonly kind = "ios-sqlite" as const;
  constructor(private readonly db: SqliteDatabase) {}

  async get(key: string): Promise<string | null> {
    const result = await this.db.query<{ value: string }>({
      sql: `SELECT value FROM ${KV_TABLE_NAME} WHERE key = ? LIMIT 1`,
      values: [key],
    });
    const first = result.rows[0];
    return first ? first.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO ${KV_TABLE_NAME} (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%s','now')`,
      values: [key, value],
    });
  }

  async remove(key: string): Promise<void> {
    await this.db.execute({
      sql: `DELETE FROM ${KV_TABLE_NAME} WHERE key = ?`,
      values: [key],
    });
  }

  async keys(): Promise<string[]> {
    const result = await this.db.query<{ key: string }>({
      sql: `SELECT key FROM ${KV_TABLE_NAME}`,
    });
    return result.rows.map((row) => row.key);
  }
}

async function openSqliteAdapter(): Promise<PersistenceAdapter> {
  const db = await openDatabase({ name: "eliza-state" });
  await db.execute({ sql: KV_TABLE_DDL });
  return new IosSqliteAdapter(db);
}

/* ── Resolver ──────────────────────────────────────────────────────────── */

/**
 * Test/dependency-injection seam. Production code calls
 * {@link resolveIosPersistenceAdapter}. Tests inject a mock to exercise the
 * decision logic without booting Capacitor.
 */
export interface IosAdapterDeps {
  isSqliteAvailable: () => Promise<boolean>;
  openSqliteAdapter: () => Promise<PersistenceAdapter>;
  resolvePreferencesAdapter: () => Promise<PersistenceAdapter>;
}

async function resolvePreferencesAdapter(): Promise<PersistenceAdapter> {
  const mod = (await import("@capacitor/preferences")) as {
    Preferences: PreferencesPlugin;
  };
  return new IosPreferencesAdapter(mod.Preferences);
}

const productionDeps: IosAdapterDeps = {
  isSqliteAvailable,
  openSqliteAdapter,
  resolvePreferencesAdapter,
};

/**
 * Pick the best available iOS persistence adapter. Prefer SQLite when the
 * `@capacitor-community/sqlite` plugin is registered; fall back to Capacitor
 * Preferences when it isn't.
 */
export async function resolveIosPersistenceAdapter(
  deps: IosAdapterDeps = productionDeps,
): Promise<PersistenceAdapter> {
  if (await deps.isSqliteAvailable()) {
    return deps.openSqliteAdapter();
  }
  return deps.resolvePreferencesAdapter();
}

/**
 * Migration helper: copy every key from the Preferences adapter into the
 * SQLite adapter. Used once on first boot after a shell update that ships
 * the SQLite plugin. Idempotent — re-running it just overwrites identical
 * values. Returns the count of keys migrated.
 */
export async function migratePreferencesToSqlite(
  preferences: PersistenceAdapter,
  sqlite: PersistenceAdapter,
): Promise<number> {
  if (preferences.kind !== "ios-preferences") {
    throw new Error(
      `[persistence] migratePreferencesToSqlite: source adapter must be ios-preferences (got ${preferences.kind})`,
    );
  }
  if (sqlite.kind !== "ios-sqlite") {
    throw new Error(
      `[persistence] migratePreferencesToSqlite: target adapter must be ios-sqlite (got ${sqlite.kind})`,
    );
  }
  const keys = await preferences.keys();
  let migrated = 0;
  for (const key of keys) {
    const value = await preferences.get(key);
    if (value === null) continue;
    await sqlite.set(key, value);
    migrated++;
  }
  return migrated;
}
