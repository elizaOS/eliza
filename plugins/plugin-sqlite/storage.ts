/**
 * Owns a single-agent SQLite file and serializes asynchronous adapter operations.
 * SQLite stores lossless V8 record blobs; transactions remain open across awaits
 * only while an AsyncLocalStorage owner holds the queue. Escaped callbacks fail.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { ElizaError, type UUID } from "@elizaos/core";
import type { IStorage } from "@elizaos/plugin-inmemorydb";

type Owner = { active: boolean; child?: Promise<void> };

export class SQLiteStorage implements IStorage {
  private database: DatabaseSync | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly owner = new AsyncLocalStorage<Owner>();
  private savepoint = 0;

  constructor(
    readonly path: string,
    readonly agentId: UUID,
  ) {
    if (process.versions.bun || process.versions.node !== "24.15.0") {
      throw this.failure(
        "RUNTIME_UNSUPPORTED",
        "Run SQLite storage with the pinned Node 24.15.0 runtime",
      );
    }
    if (!isAbsolute(path))
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

  private connection(): DatabaseSync {
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
      const db = new DatabaseSync(this.path);
      try {
        db.exec(
          "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
        );
        db.exec("BEGIN EXCLUSIVE");
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 0 && version !== 1)
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
        if (stored !== undefined && stored !== this.agentId)
          throw this.failure(
            "AGENT_MISMATCH",
            "SQLite database belongs to a different agent",
          );
        db.prepare(
          "INSERT OR IGNORE INTO metadata(key,value) VALUES('agent_id',?)",
        ).run(this.agentId);
        db.exec("PRAGMA user_version=1; COMMIT");
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
      return deserialize(row.data) as T;
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
          return deserialize(row.data) as T;
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
        .run(collection, id, serialize(data));
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
        if (predicate(deserialize(row.data) as T))
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
    this.requireOutsideTransaction();
    if (!isAbsolute(destination) || existsSync(destination))
      throw this.failure(
        "BACKUP_PATH_INVALID",
        "Backup requires a new absolute path",
      );
    await this.exclusive(async () => {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      // VACUUM INTO includes committed WAL pages in a consistent standalone file.
      closeSync(openSync(destination, "wx", 0o600));
      this.connection().prepare("VACUUM INTO ?").run(destination);
      chmodSync(destination, 0o600);
    });
  }
}

/** Durable map-shaped access for connector records inside the adapter transaction. */
export class SQLiteCollection<T> {
  constructor(
    private readonly connection: () => DatabaseSync,
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
    return deserialize(row.data) as T;
  }
  set(id: string, value: T): void {
    this.connection()
      .prepare(
        "INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data",
      )
      .run(this.name, id, serialize(value));
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
      yield [row.id, deserialize(row.data) as T];
    }
  }
  values(): T[] {
    return Array.from(this, ([, value]) => value);
  }
}
