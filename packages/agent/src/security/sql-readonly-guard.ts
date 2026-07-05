/**
 * Shared read-only SQL guard for prompt-reachable database access. The action
 * and API database paths both sanitize comments/literals before scanning, so
 * model-generated SQL cannot hide mutation keywords in split tokens or make the
 * guard spend unbounded time in comment/string handling.
 */
import {
  stripSqlBlockComments,
  stripSqlDollarQuotedLiterals,
} from "../shared/sql-sanitizers.ts";

// Mirrors the server-side allowlist in api/database.ts. The scanner removes
// comments and literals first so keywords in data do not trip the guard.
const MUTATION_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "INTO",
  "COPY",
  "MERGE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "COMMENT",
  "GRANT",
  "REVOKE",
  "SET",
  "RESET",
  "LOAD",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "DISCARD",
  "CALL",
  "DO",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "LOCK",
];

const DANGEROUS_FUNCTIONS = [
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_put",
  "lo_from_bytea",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_write_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",
  "nextval",
  "setval",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "set_config",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_shared",
  "pg_advisory_unlock_all",
];

export function checkReadOnly(
  sqlText: string,
): { ok: true } | { ok: false; reason: string } {
  const stripped = stripSqlBlockComments(sqlText).replace(/--.*$/gm, "").trim();
  const noLiterals = stripSqlDollarQuotedLiterals(stripped).replace(
    /'(?:[^']|'')*'/g,
    " ",
  );
  const noStrings = noLiterals.replace(/"(?:[^"]|"")*"/g, " ");

  // PostgreSQL unicode-escaped quoted identifiers can decode to dangerous
  // function names only at parse time, so reject the token after removing
  // comments and string literals.
  if (/[uU]&"/.test(noLiterals)) {
    return {
      ok: false,
      reason:
        'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    };
  }

  const mutation = new RegExp(
    `\\b(${MUTATION_KEYWORDS.join("|")})\\b`,
    "i",
  ).exec(noStrings);
  if (mutation) {
    return {
      ok: false,
      reason: `"${mutation[1].toUpperCase()}" is a mutation keyword. Set allowWrites:true to execute mutations.`,
    };
  }

  const fn = new RegExp(
    `(?:^|[^\\w$])"?(?:${DANGEROUS_FUNCTIONS.join("|")})"?\\s*\\(`,
    "i",
  ).exec(noLiterals);
  if (fn) {
    const name = new RegExp(`(${DANGEROUS_FUNCTIONS.join("|")})`, "i").exec(
      fn[0],
    );
    return {
      ok: false,
      reason: `"${(name?.[1] ?? "UNKNOWN").toUpperCase()}" is a dangerous function. Set allowWrites:true to execute.`,
    };
  }

  if (stripped.replace(/;\s*$/, "").includes(";")) {
    return {
      ok: false,
      reason: "Multi-statement queries are not allowed in read-only mode.",
    };
  }

  return { ok: true };
}
