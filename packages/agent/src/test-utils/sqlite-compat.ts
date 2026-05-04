import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SqliteValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | null;

export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteRunResult {
  changes?: number;
  lastInsertRowid?: number | bigint;
}

export interface SqliteStatementCompat {
  all(...params: SqliteValue[]): SqliteRow[];
  get(...params: SqliteValue[]): SqliteRow | null;
  run(...params: SqliteValue[]): SqliteRunResult;
}

export interface SqliteDatabaseCompat {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementCompat;
  close(): void;
}

export interface SqliteDatabaseSyncConstructor {
  new (filename: string): SqliteDatabaseCompat;
}

interface BunSqliteQueryCompat {
  all(...params: SqliteValue[]): SqliteRow[];
  get(...params: SqliteValue[]): SqliteRow | null | undefined;
  run(...params: SqliteValue[]): SqliteRunResult;
}

interface BunSqliteDatabaseCompat {
  exec(sql: string): void;
  query(sql: string): BunSqliteQueryCompat;
  close(): void;
}

interface BunSqliteModule {
  Database: new (filename: string) => BunSqliteDatabaseCompat;
}

const require = createRequire(import.meta.url);
let DatabaseSyncValue: SqliteDatabaseSyncConstructor | undefined;
let hasSqliteValue = false;

type SerializedSqliteValue =
  | Exclude<SqliteValue, bigint | Uint8Array>
  | { __sqliteType: "bigint"; value: string }
  | { __sqliteType: "uint8array"; value: number[] };

type BunCliSqliteOperation = "exec" | "all" | "get" | "run";

interface BunCliSqlitePayload {
  filename: string;
  operation: BunCliSqliteOperation;
  sql: string;
  params: SerializedSqliteValue[];
}

type BunCliSqliteResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: { message: string; stack?: string } };

const BUN_SQLITE_BRIDGE_SCRIPT = `
import { Database } from "bun:sqlite";

const payload = JSON.parse(await Bun.stdin.text());

function reviveSqliteValue(value) {
  if (value && typeof value === "object") {
    if (value.__sqliteType === "bigint") {
      return BigInt(value.value);
    }
    if (value.__sqliteType === "uint8array") {
      return new Uint8Array(value.value);
    }
  }
  return value;
}

function replaceSqliteValue(_key, value) {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  return value;
}

const db = new Database(payload.filename);

try {
  let result = null;
  if (payload.operation === "exec") {
    db.exec(payload.sql);
  } else {
    const params = payload.params.map(reviveSqliteValue);
    const query = db.query(payload.sql);
    if (payload.operation === "all") {
      result = query.all(...params);
    } else if (payload.operation === "get") {
      result = query.get(...params) ?? null;
    } else if (payload.operation === "run") {
      result = query.run(...params);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, result }, replaceSqliteValue));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  process.stdout.write(JSON.stringify({ ok: false, error: { message, stack } }));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

function isBunRuntime(): boolean {
  return (
    typeof process !== "undefined" && typeof process.versions?.bun === "string"
  );
}

function hasBunCli(): boolean {
  const result = spawnSync("bun", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0;
}

function serializeSqliteValue(value: SqliteValue): SerializedSqliteValue {
  if (typeof value === "bigint") {
    return { __sqliteType: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { __sqliteType: "uint8array", value: Array.from(value) };
  }
  return value;
}

function runBunSqliteCli<T>(payload: BunCliSqlitePayload): T {
  const result = spawnSync("bun", ["--eval", BUN_SQLITE_BRIDGE_SCRIPT], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 50 * 1024 * 1024,
  });
  const stdout = result.stdout.trim();
  let response: BunCliSqliteResponse<T> | undefined;

  if (stdout.length > 0) {
    try {
      response = JSON.parse(stdout) as BunCliSqliteResponse<T>;
    } catch {
      const detail = result.stderr.trim() || stdout;
      throw new Error(
        `[sqlite-compat] Could not parse Bun SQLite output: ${detail}`,
      );
    }
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || response?.ok === false || !response) {
    const message =
      response?.ok === false
        ? response.error.message
        : result.stderr.trim() ||
          `Bun SQLite bridge exited with status ${result.status ?? "unknown"}`;
    throw new Error(`[sqlite-compat] ${message}`);
  }

  return response.result;
}

class BunCliDatabaseSyncCompat implements SqliteDatabaseCompat {
  private readonly filename: string;
  private readonly deleteOnClose: boolean;

  constructor(filename: string) {
    this.deleteOnClose = filename === ":memory:";
    this.filename = this.deleteOnClose
      ? join(tmpdir(), `eliza-sqlite-${process.pid}-${randomUUID()}.sqlite`)
      : filename;
  }

  exec(sql: string): void {
    runBunSqliteCli<null>({
      filename: this.filename,
      operation: "exec",
      sql,
      params: [],
    });
  }

  prepare(sql: string): SqliteStatementCompat {
    return {
      all: (...params) =>
        runBunSqliteCli<SqliteRow[]>({
          filename: this.filename,
          operation: "all",
          sql,
          params: params.map(serializeSqliteValue),
        }),
      get: (...params) =>
        runBunSqliteCli<SqliteRow | null>({
          filename: this.filename,
          operation: "get",
          sql,
          params: params.map(serializeSqliteValue),
        }),
      run: (...params) =>
        runBunSqliteCli<SqliteRunResult>({
          filename: this.filename,
          operation: "run",
          sql,
          params: params.map(serializeSqliteValue),
        }),
    };
  }

  close(): void {
    if (!this.deleteOnClose) {
      return;
    }
    for (const filename of [
      this.filename,
      `${this.filename}-shm`,
      `${this.filename}-wal`,
    ]) {
      if (existsSync(filename)) {
        unlinkSync(filename);
      }
    }
  }
}

try {
  ({ DatabaseSync: DatabaseSyncValue } = require("node:sqlite") as {
    DatabaseSync: SqliteDatabaseSyncConstructor;
  });
  hasSqliteValue = typeof DatabaseSyncValue === "function";
} catch {
  DatabaseSyncValue = undefined;
}

if (!hasSqliteValue) {
  if (isBunRuntime()) {
    try {
      const { Database } = require("bun:sqlite") as BunSqliteModule;

      class BunDatabaseSyncCompat implements SqliteDatabaseCompat {
        private readonly db: BunSqliteDatabaseCompat;

        constructor(filename: string) {
          this.db = new Database(filename);
        }

        exec(sql: string): void {
          this.db.exec(sql);
        }

        prepare(sql: string): SqliteStatementCompat {
          const query = this.db.query(sql);
          return {
            all: (...params) => query.all(...params),
            get: (...params) => query.get(...params) ?? null,
            run: (...params) => query.run(...params),
          };
        }

        close(): void {
          this.db.close();
        }
      }

      DatabaseSyncValue = BunDatabaseSyncCompat;
      hasSqliteValue = true;
    } catch {
      hasSqliteValue = false;
    }
  } else if (hasBunCli()) {
    DatabaseSyncValue = BunCliDatabaseSyncCompat;
    hasSqliteValue = true;
  } else {
    hasSqliteValue = false;
  }
}

export const hasSqlite = hasSqliteValue;
export const DatabaseSync = DatabaseSyncValue as SqliteDatabaseSyncConstructor;
export type SqliteDatabaseSync = InstanceType<SqliteDatabaseSyncConstructor>;
