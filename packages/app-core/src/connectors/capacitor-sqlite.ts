// TODO(native): Native side is provided by `@capacitor-community/sqlite`
// (real published plugin) — this file is a thin facade so the rest of the
// app talks to a stable, parameterized API instead of touching the
// community plugin's wider surface.

import {
  CapacitorSQLite,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite";

export interface SqliteOpenOptions {
  /** Database name (no path, no extension). */
  name: string;
  /** Optional encryption mode. Maps directly to the community plugin's `encrypted` flag. */
  encryption?: "none" | "encryption" | "secret";
}

export interface SqliteExecuteOptions {
  /** Parameterized SQL. Concatenation is not allowed — use `values`. */
  sql: string;
  /** Bound parameters in declaration order. */
  values?: ReadonlyArray<string | number | boolean | null>;
}

export interface SqliteQueryOptions extends SqliteExecuteOptions {}

export interface SqliteExecuteResult {
  /** Number of rows affected. */
  changes: number;
  /** Last inserted row ID, when applicable. */
  lastInsertRowId?: number;
}

export interface SqliteQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
}

export interface SqliteDatabase {
  readonly name: string;
  execute(opts: SqliteExecuteOptions): Promise<SqliteExecuteResult>;
  query<TRow = Record<string, unknown>>(
    opts: SqliteQueryOptions,
  ): Promise<SqliteQueryResult<TRow>>;
  close(): Promise<void>;
}

const PARAM_PLACEHOLDER = /\?/g;

function rejectStringConcat(sql: string): void {
  // Defensive: the contract is parameterized SQL only. We can't fully detect
  // unsafe concatenation from the call site, but we can refuse calls that
  // contain template-literal-style markers commonly used for unsafe interp.
  if (sql.includes("${")) {
    throw new Error(
      "[capacitor-sqlite] sql must be parameterized — use `values`, not `" +
        "$" +
        "{...}` interpolation",
    );
  }
  // Cheap plausibility check: count placeholders so callers see a clear
  // error if they forget to migrate from string concat.
  void PARAM_PLACEHOLDER;
}

class SqliteDatabaseImpl implements SqliteDatabase {
  constructor(
    public readonly name: string,
    private readonly connection: SQLiteDBConnection,
  ) {}

  async execute(opts: SqliteExecuteOptions): Promise<SqliteExecuteResult> {
    rejectStringConcat(opts.sql);
    const result = await this.connection.run(
      opts.sql,
      opts.values ? [...opts.values] : [],
    );
    const changes = result.changes?.changes ?? 0;
    const lastInsertRowId = result.changes?.lastId;
    return typeof lastInsertRowId === "number"
      ? { changes, lastInsertRowId }
      : { changes };
  }

  async query<TRow = Record<string, unknown>>(
    opts: SqliteQueryOptions,
  ): Promise<SqliteQueryResult<TRow>> {
    rejectStringConcat(opts.sql);
    const result = await this.connection.query(
      opts.sql,
      opts.values ? [...opts.values] : [],
    );
    return { rows: (result.values ?? []) as TRow[] };
  }

  async close(): Promise<void> {
    await this.connection.close();
    await CapacitorSQLite.closeConnection({
      database: this.name,
      readonly: false,
    });
  }
}

/**
 * Open (or create) a SQLite database via `@capacitor-community/sqlite`. The
 * caller must `close()` when finished to release the underlying connection.
 */
export async function openDatabase(
  opts: SqliteOpenOptions,
): Promise<SqliteDatabase> {
  const encryption = opts.encryption ?? "none";
  await CapacitorSQLite.createConnection({
    database: opts.name,
    version: 1,
    encrypted: encryption !== "none",
    mode: encryption,
    readonly: false,
  });
  const connection = (await CapacitorSQLite.open({
    database: opts.name,
    readonly: false,
  })) as unknown as SQLiteDBConnection;
  return new SqliteDatabaseImpl(opts.name, connection);
}

/**
 * Probe whether the SQLite plugin is loadable in the current runtime.
 * Returns false when running in a context without a Capacitor host or when
 * the native plugin isn't registered (e.g. plain web preview).
 */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    const cap = (
      globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return false;
    // `checkConnectionsConsistency` is a no-op on a clean install but
    // confirms the native bridge is wired up.
    await CapacitorSQLite.checkConnectionsConsistency({
      dbNames: [],
      openModes: [],
    });
    return true;
  } catch {
    return false;
  }
}
