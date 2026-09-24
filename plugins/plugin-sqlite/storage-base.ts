/**
 * Owns a single-agent SQLite file and serializes asynchronous adapter operations.
 * SQLite stores versioned portable record blobs; transactions remain open across awaits
 * only while an AsyncLocalStorage owner holds the queue. Escaped callbacks fail.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deserialize as deserializeLegacy } from "node:v8";
import { ElizaError, logger, type UUID } from "@elizaos/core";
import type { IStorage } from "./types";
import { decodeRecord, encodeRecord, RECORD_CODEC } from "./record-codec";
import type { SqlDatabase, SQLiteDriver } from "./sqlite-driver-types";

type Owner = { active: boolean; child?: Promise<void> };

/** Persist the published name and any ancestors created for a new backup directory. */
function syncDirectoryChain(directory: string): void {
  let current = directory;
  for (;;) {
    const fd = openSync(current, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export class SQLiteStorageBase implements IStorage {
  private database: SqlDatabase | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly owner = new AsyncLocalStorage<Owner>();
  private savepoint = 0;

  constructor(
    readonly path: string,
    readonly agentId: UUID,
    private readonly driver: SQLiteDriver,
  ) {
    driver.assertSupportedRuntime();
    if (!driver.supportsFileSystem && path !== ":memory:") {
      throw this.failure("PORTABLE_PATH_UNSUPPORTED", "Portable SQLite supports only :memory: databases");
    }
    if (path !== ":memory:" && !isAbsolute(path))
      throw this.failure(
        "PATH_INVALID",
        "SQLite database path must be absolute",
      );
  }

  private failure(code: string, message: string, cause?: unknown): ElizaError {
    return new ElizaError(message, {
      code: `SQLITE_${code}`,
      context: { agentId: this.agentId },
      cause,
    });
  }

  private requireOutsideTransaction(): void {
    if (this.owner.getStore())
      throw this.failure(
        "LIFECYCLE_IN_TRANSACTION",
        "Initialize, close and backup must run outside database transactions",
      );
  }

  private connection(): SqlDatabase {
    if (!this.database)
      throw this.failure(
        "NOT_READY",
        "Initialize the SQLite adapter before use",
      );
    return this.database;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.owner.getStore();
    if (current) {
      if (!current.active)
        throw this.failure(
          "TRANSACTION_EXPIRED",
          "Database work escaped its completed transaction",
        );
      if (current.child)
        throw this.failure(
          "TRANSACTION_OVERLAP",
          "Await a nested transaction before starting sibling database work",
        );
      return operation();
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const token = { active: true };
    try {
      return await this.owner.run(token, operation);
    } finally {
      token.active = false;
      release();
    }
  }

  async init(): Promise<void> {
    this.requireOutsideTransaction();
    await this.exclusive(async () => {
      if (this.database) return;
      if (this.path !== ":memory:") {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        if (existsSync(this.path)) {
          const stat = lstatSync(this.path);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw this.failure(
              "PATH_INVALID",
              "SQLite path must be a regular file",
            );
        } else {
          closeSync(openSync(this.path, "wx", 0o600));
        }
        chmodSync(this.path, 0o600);
      }
      const db = await this.driver.open(this.path);
      try {
        db.exec(
          "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
        );
        db.exec("BEGIN EXCLUSIVE");
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 0 && version !== 1 && version !== 2)
          throw this.failure(
            "SCHEMA_UNSUPPORTED",
            "SQLite database schema requires a compatible adapter version",
          );
        db.exec(
          "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (collection, id)) STRICT;",
        );
        const stored = db
          .prepare("SELECT value FROM metadata WHERE key='agent_id'")
          .get()?.value;
        if (version !== 0 && stored === undefined) {
          throw this.failure(
            "AGENT_BINDING_MISSING",
            "Existing database is missing its agent binding; restore verified metadata before opening",
          );
        }
        if (stored !== undefined && stored !== this.agentId)
          throw this.failure(
            "AGENT_MISMATCH",
            "SQLite database belongs to a different agent",
          );
        db.prepare(
          "INSERT OR IGNORE INTO metadata(key,value) VALUES('agent_id',?)",
        ).run(this.agentId);
        const codec = db
          .prepare("SELECT value FROM metadata WHERE key='record_codec'")
          .get()?.value;
        if (version === 2 && codec !== RECORD_CODEC) {
          throw this.failure(
            "RECORD_CODEC_UNSUPPORTED",
            "Database record codec requires a compatible release",
          );
        }
        if (
          version === 0 &&
          db.prepare("SELECT 1 AS present FROM records LIMIT 1").get()
        ) {
          throw this.failure(
            "SCHEMA_UNSUPPORTED",
            "Unversioned records require an explicit importer",
          );
        }
        if (version === 1) {
          if (process.versions.bun) {
            throw this.failure(
              "MIGRATION_REQUIRES_NODE",
              "Back up and open this legacy database with pinned Node 24.15.0 to migrate before using Bun",
            );
          }
          if (codec !== undefined)
            throw this.failure(
              "RECORD_CODEC_UNSUPPORTED",
              "Legacy database has an unexpected codec declaration",
            );
          for (const row of db
            .prepare(
              "SELECT collection,id,data FROM records ORDER BY collection,id",
            )
            .all()) {
            if (
              typeof row.collection !== "string" ||
              typeof row.id !== "string" ||
              !(row.data instanceof Uint8Array)
            ) {
              throw this.failure(
                "RECORD_INVALID",
                "Legacy record has invalid storage fields",
              );
            }
            const value: unknown = deserializeLegacy(row.data);
            const encoded = encodeRecord(value);
            if (!isDeepStrictEqual(value, decodeRecord(encoded))) {
              throw this.failure(
                "MIGRATION_VALUE_UNSUPPORTED",
                "Legacy value cannot be migrated losslessly; retain the original database and use a compatible importer",
              );
            }
            db.prepare(
              "UPDATE records SET data=? WHERE collection=? AND id=?",
            ).run(encoded, row.collection, row.id);
          }
        }
        db.prepare(
          "INSERT OR REPLACE INTO metadata(key,value) VALUES('record_codec',?)",
        ).run(RECORD_CODEC);
        db.exec("PRAGMA user_version=2; COMMIT");
        this.database = db;
      } catch (cause) {
        // error-policy:J2 Close the failed open and preserve its actionable cause.
        db.close();
        throw this.failure(
          "OPEN_FAILED",
          "Cannot open the agent SQLite database; check ownership, schema and exclusive use",
          cause,
        );
      }
    });
  }

  async operation<T>(
    operation: () => Promise<T>,
    onRollback: () => Promise<void>,
  ): Promise<T> {
    return this.transaction(operation, onRollback);
  }

  async transaction<T>(
    operation: () => Promise<T>,
    onRollback?: () => Promise<void>,
  ): Promise<T> {
    return this.exclusive(async () => {
      const parent = this.owner.getStore();
      if (!parent)
        throw this.failure(
          "TRANSACTION_REQUIRED",
          "Missing transaction ownership",
        );
      let completed!: () => void;
      parent.child = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const token: Owner = { active: true };
      try {
        return await this.owner.run(token, async () => {
          const db = this.connection();
          const name = `operation_${++this.savepoint}`;
          db.exec(`SAVEPOINT ${name}`);
          try {
            const value = await operation();
            if (token.child) {
              await token.child;
              throw this.failure(
                "TRANSACTION_UNAWAITED",
                "Await every nested transaction before returning from its parent",
              );
            }
            db.exec(`RELEASE SAVEPOINT ${name}`);
            return value;
          } catch (cause) {
            // error-policy:J2 Await nested work before rolling back its complete parent scope.
            if (token.child) await token.child;
            db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
            if (onRollback) await onRollback();
            if (cause instanceof ElizaError) throw cause;
            throw this.failure(
              "TRANSACTION_FAILED",
              "SQLite operation rolled back",
              cause,
            );
          }
        });
      } finally {
        token.active = false;
        parent.child = undefined;
        completed();
      }
    });
  }

  async close(beforeClose?: () => Promise<void>): Promise<void> {
    this.requireOutsideTransaction();
    await this.exclusive(async () => {
      const db = this.database;
      if (!db) return;
      if (beforeClose) await beforeClose();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      this.database = null;
    });
  }

  async isReady(): Promise<boolean> {
    return this.database !== null;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    return this.exclusive(async () => {
      const row = this.connection()
        .prepare("SELECT data FROM records WHERE collection=? AND id=?")
        .get(collection, id);
      if (!row) return null;
      if (!(row.data instanceof Uint8Array))
        throw this.failure(
          "RECORD_INVALID",
          "SQLite record is not a binary payload",
        );
      return decodeRecord(row.data) as T;
    });
  }

  async getAll<T>(collection: string): Promise<T[]> {
    return this.exclusive(async () =>
      this.connection()
        .prepare("SELECT data FROM records WHERE collection=? ORDER BY id")
        .all(collection)
        .map((row) => {
          if (!(row.data instanceof Uint8Array))
            throw this.failure(
              "RECORD_INVALID",
              "SQLite record is not a binary payload",
            );
          return decodeRecord(row.data) as T;
        }),
    );
  }

  async getWhere<T>(
    collection: string,
    predicate: (item: T) => boolean,
  ): Promise<T[]> {
    return (await this.getAll<T>(collection)).filter(predicate);
  }

  async set<T>(collection: string, id: string, data: T): Promise<void> {
    await this.exclusive(async () => {
      this.connection()
        .prepare(
          "INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data",
        )
        .run(collection, id, encodeRecord(data));
    });
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.exclusive(
      async () =>
        this.connection()
          .prepare("DELETE FROM records WHERE collection=? AND id=?")
          .run(collection, id).changes > 0,
    );
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
    await this.transaction(async () => {
      for (const id of ids) await this.delete(collection, id);
    });
  }

  async deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean,
  ): Promise<void> {
    await this.transaction(async () => {
      const rows = this.connection()
        .prepare("SELECT id,data FROM records WHERE collection=?")
        .all(collection);
      for (const row of rows) {
        if (typeof row.id !== "string" || !(row.data instanceof Uint8Array))
          throw this.failure(
            "RECORD_INVALID",
            "SQLite record has invalid storage fields",
          );
        if (predicate(decodeRecord(row.data) as T))
          await this.delete(collection, row.id);
      }
    });
  }

  async count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean,
  ): Promise<number> {
    const rows = await this.getAll<T>(collection);
    return predicate ? rows.filter(predicate).length : rows.length;
  }

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      this.connection().exec("DELETE FROM records");
    });
  }

  async applyBatch(batch: {
    collection: string;
    deletes: string[];
    sets: Array<{ id: string; data: unknown }>;
  }): Promise<void> {
    await this.transaction(async () => {
      await this.deleteMany(batch.collection, batch.deletes);
      for (const row of batch.sets)
        await this.set(batch.collection, row.id, row.data);
    });
  }

  /** Synchronous collections are available only within an owned adapter transaction. */
  collection<T>(name: string): SQLiteCollection<T> {
    return new SQLiteCollection<T>(() => {
      if (!this.owner.getStore()?.active)
        throw this.failure(
          "TRANSACTION_REQUIRED",
          "Collection access requires an active adapter transaction",
        );
      return this.connection();
    }, name);
  }

  async backup(destination: string): Promise<void> {
    if (!this.driver.supportsFileSystem) {
      throw this.failure("PORTABLE_BACKUP_UNSUPPORTED", "Portable SQLite has no persistent filesystem for backups");
    }
    this.requireOutsideTransaction();
    if (!isAbsolute(destination) || existsSync(destination))
      throw this.failure(
        "BACKUP_PATH_INVALID",
        "Backup requires a new absolute path",
      );
    await this.exclusive(async () => {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      // Some SQLite builds require a nonexistent VACUUM destination. A private
      // sibling directory protects the new file until exclusive publication.
      const staging = mkdtempSync(
        join(dirname(destination), `.${basename(destination)}-`),
      );
      try {
        chmodSync(staging, 0o700);
        const snapshot = join(staging, "snapshot.sqlite");
        this.connection().prepare("VACUUM INTO ?").run(snapshot);
        chmodSync(snapshot, 0o600);
        const snapshotFd = openSync(snapshot, "r");
        try {
          fsyncSync(snapshotFd);
        } finally {
          closeSync(snapshotFd);
        }
        linkSync(snapshot, destination);
        syncDirectoryChain(dirname(destination));
      } catch (cause) {
        // error-policy:J2 Unsupported publication or directory durability must not report a completed backup.
        throw this.failure(
          "BACKUP_PUBLICATION_FAILED",
          "Backup publication could not be made durable; use a filesystem supporting hard links and directory fsync, and inspect the destination before retrying",
          cause,
        );
      } finally {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch (error) {
          // error-policy:J6 A cleanup failure must not disguise the backup's publication outcome.
          logger.warn(
            { src: "SQLiteStorage", error: String(error) },
            "[SQLiteStorage] Backup staging cleanup failed",
          );
        }
      }
    });
  }
}

/** Durable map-shaped access for connector records inside the adapter transaction. */
export class SQLiteCollection<T> {
  constructor(
    private readonly connection: () => SqlDatabase,
    private readonly name: string,
  ) {}
  get(id: string): T | undefined {
    const row = this.connection()
      .prepare("SELECT data FROM records WHERE collection=? AND id=?")
      .get(this.name, id);
    if (!row) return undefined;
    if (!(row.data instanceof Uint8Array))
      throw new ElizaError("Invalid SQLite record payload", {
        code: "SQLITE_RECORD_INVALID",
      });
    return decodeRecord(row.data) as T;
  }
  set(id: string, value: T): void {
    this.connection()
      .prepare(
        "INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data",
      )
      .run(this.name, id, encodeRecord(value));
  }
  delete(id: string): boolean {
    return (
      this.connection()
        .prepare("DELETE FROM records WHERE collection=? AND id=?")
        .run(this.name, id).changes > 0
    );
  }
  *[Symbol.iterator](): IterableIterator<[string, T]> {
    for (const row of this.connection()
      .prepare("SELECT id,data FROM records WHERE collection=? ORDER BY id")
      .all(this.name)) {
      if (typeof row.id !== "string" || !(row.data instanceof Uint8Array))
        throw new ElizaError("Invalid SQLite record fields", {
          code: "SQLITE_RECORD_INVALID",
        });
      yield [row.id, decodeRecord(row.data) as T];
    }
  }
  values(): T[] {
    return Array.from(this, ([, value]) => value);
  }
}
