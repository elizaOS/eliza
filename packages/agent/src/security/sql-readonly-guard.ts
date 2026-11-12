/**
 * Shared read-only SQL path for prompt-reachable database access. The scanner
 * is a pre-filter: it allows only read-shaped leading statements and refuses
 * functions that a READ ONLY transaction still lets run. The query itself then
 * runs inside the adapter's transaction API under SET TRANSACTION READ ONLY and
 * is always rolled back, so a mutation that slips past the scanner fails in the
 * database instead of committing.
 */
import { scanSqlForReadOnly } from "../shared/sql-sanitizers.ts";

const READ_ONLY_LEADING_STATEMENTS = [
  "SELECT",
  "WITH",
  "SHOW",
  "EXPLAIN",
  "VALUES",
  "TABLE",
];

// Functions a READ ONLY transaction does not stop: server file access, side
// channels, session state, sequences, SQL built from text, sleeps and locks.
const DANGEROUS_FUNCTIONS = [
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_put",
  "lo_from_bytea",
  "lo_create",
  "lo_creat",
  "lowrite",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_write_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",
  "pg_notify",
  "nextval",
  "setval",
  "set_config",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_connect_u",
  "dblink_send_query",
  "dblink_open",
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_shared",
  "pg_advisory_unlock_all",
];

export function checkReadOnly(
  sqlText: string,
): { ok: true } | { ok: false; reason: string } {
  const scan = scanSqlForReadOnly(sqlText);
  if (!scan.ok) return scan;

  const leading = /^[\s(]*([A-Za-z_]+)/.exec(scan.keywordText)?.[1];
  const statement = leading?.toUpperCase();
  if (!statement || !READ_ONLY_LEADING_STATEMENTS.includes(statement)) {
    return {
      ok: false,
      reason: `only ${READ_ONLY_LEADING_STATEMENTS.join(", ")} statements run in read-only mode.`,
    };
  }
  if (statement === "EXPLAIN" && /\bANALY[SZ]E\b/i.test(scan.keywordText)) {
    return {
      ok: false,
      reason: "EXPLAIN ANALYZE runs the statement it explains.",
    };
  }

  const fn = new RegExp(
    `(?:^|[^\\w$])"?(?:${DANGEROUS_FUNCTIONS.join("|")})"?\\s*\\(`,
    "i",
  ).exec(scan.callableText);
  if (fn) {
    const name = new RegExp(`(${DANGEROUS_FUNCTIONS.join("|")})`, "i").exec(
      fn[0],
    );
    return {
      ok: false,
      reason: `"${(name?.[1] ?? "UNKNOWN").toUpperCase()}" is not allowed in read-only mode.`,
    };
  }

  if (scan.structuralText.trim().replace(/;\s*$/, "").includes(";")) {
    return {
      ok: false,
      reason: "multi-statement queries are not allowed in read-only mode.",
    };
  }

  return { ok: true };
}

interface RawExecuteResult {
  rows?: unknown;
  fields?: Array<{ name: string }>;
}

interface RawExecutor {
  execute(query: unknown): Promise<RawExecuteResult>;
}

interface TransactionalDb extends RawExecutor {
  transaction<T>(run: (tx: RawExecutor) => Promise<T>): Promise<T>;
}

function hasTransaction(db: unknown): db is TransactionalDb {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { transaction?: unknown }).transaction === "function"
  );
}

class ReadOnlyRollback extends Error {
  constructor(
    readonly result: { rows: Record<string, unknown>[]; columns: string[] },
  ) {
    super("read-only query rolled back");
  }
}

/**
 * Run SQL that passed {@link checkReadOnly} inside one READ ONLY transaction
 * held through the adapter's transaction API, then roll it back. Separate
 * BEGIN/ROLLBACK statements would share PGlite's single connection with
 * concurrent agent writes. An adapter without a transaction API fails closed.
 */
export async function executeReadOnlySql(
  db: unknown,
  sqlText: string,
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  if (!hasTransaction(db)) {
    throw new Error(
      "Read-only queries need a database adapter with transaction support.",
    );
  }
  const { sql } = (await import("drizzle-orm")) as {
    sql: { raw(query: string): unknown };
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '10s'"));
      const result = await tx.execute(sql.raw(sqlText));
      const rows = Array.isArray(result.rows)
        ? result.rows.filter(
            (row): row is Record<string, unknown> =>
              typeof row === "object" && row !== null,
          )
        : [];
      const columns =
        result.fields?.map((f) => f.name) ??
        (rows.length > 0 ? Object.keys(rows[0]) : []);
      throw new ReadOnlyRollback({ rows, columns });
    });
  } catch (err) {
    if (err instanceof ReadOnlyRollback) return err.result;
    throw err;
  }
  throw new Error("Read-only transaction did not run the query.");
}
