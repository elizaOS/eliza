/**
 * Behavioral unit coverage for checkReadOnly. Drives the real guard and the
 * linear scanner it wraps: scan-failure passthrough, every mutation keyword,
 * every dangerous function, write-override interpolation, multi-statement
 * detection, and the allow path. Deterministic — no mocks, network, or adapter.
 */

import { describe, expect, it } from "vitest";
import { MAX_READ_ONLY_SQL_LENGTH } from "../shared/sql-sanitizers.ts";
import { checkReadOnly } from "./sql-readonly-guard.ts";

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
] as const;

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
] as const;

/**
 * The callable-name extractor runs `DANGEROUS_FUNCTIONS` as an unanchored
 * alternation over the already-matched call text, so an earlier list entry
 * that is a substring of a later one wins (pg_sleep before pg_sleep_for).
 */
function reportedDangerousName(fn: string): string {
  const found = DANGEROUS_FUNCTIONS.find((candidate) =>
    fn.toLowerCase().includes(candidate.toLowerCase()),
  );
  return (found ?? fn).toUpperCase();
}

describe("checkReadOnly", () => {
  it("allows empty SQL", () => {
    expect(checkReadOnly("")).toEqual({ ok: true });
  });

  it("allows whitespace-only SQL", () => {
    expect(checkReadOnly("   \n\t  ")).toEqual({ ok: true });
  });

  it("allows a single SELECT", () => {
    expect(checkReadOnly("SELECT 1")).toEqual({ ok: true });
  });

  it("allows a single trailing semicolon", () => {
    expect(checkReadOnly("SELECT id FROM memories;")).toEqual({ ok: true });
  });

  it("allows trailing semicolon with following whitespace", () => {
    expect(checkReadOnly("SELECT 1;  \n")).toEqual({ ok: true });
  });

  it("allows WITH / EXPLAIN reads that contain no mutation keyword", () => {
    expect(checkReadOnly("WITH x AS (SELECT 1 AS n) SELECT n FROM x")).toEqual({
      ok: true,
    });
    expect(checkReadOnly("EXPLAIN SELECT 1")).toEqual({ ok: true });
  });

  it("allows IN without matching the INTO mutation keyword", () => {
    expect(checkReadOnly("SELECT * FROM t WHERE id IN (1, 2)")).toEqual({
      ok: true,
    });
  });

  it("allows a mutation-like identifier when it is not a whole word", () => {
    expect(checkReadOnly("SELECT inserting FROM t")).toEqual({ ok: true });
    expect(checkReadOnly("SELECT updated FROM t")).toEqual({ ok: true });
  });

  it("ignores mutation keywords inside single-quoted strings", () => {
    expect(checkReadOnly("SELECT 'DELETE FROM memories'")).toEqual({
      ok: true,
    });
  });

  it("ignores mutation keywords inside double-quoted identifiers", () => {
    expect(checkReadOnly('SELECT "delete" FROM t')).toEqual({ ok: true });
  });

  it("ignores mutation keywords inside dollar-quoted literals", () => {
    expect(checkReadOnly("SELECT $$DROP TABLE t$$")).toEqual({ ok: true });
  });

  it("does not treat a dangerous-function substring as callable", () => {
    expect(checkReadOnly("SELECT my_pg_sleep()")).toEqual({ ok: true });
    expect(checkReadOnly("SELECT pg_sleep2()")).toEqual({ ok: true });
  });

  it("does not treat $nextval( as a dangerous call ($ is not a function boundary)", () => {
    expect(checkReadOnly("SELECT $nextval(1)")).toEqual({ ok: true });
  });

  it.each(MUTATION_KEYWORDS)(
    "rejects mutation keyword %s with the default write override",
    (keyword) => {
      expect(checkReadOnly(`${keyword} x`)).toEqual({
        ok: false,
        reason: `"${keyword}" is a mutation keyword. Set allowWrites:true to execute mutations.`,
      });
    },
  );

  it("uppercases a lowercase mutation keyword in the reason", () => {
    expect(checkReadOnly("delete FROM memories")).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it("interpolates a custom write override into the mutation reason", () => {
    expect(
      checkReadOnly("UPDATE memories SET n = 1", "allowWrites:yes"),
    ).toEqual({
      ok: false,
      reason:
        '"UPDATE" is a mutation keyword. Set allowWrites:yes to execute mutations.',
    });
  });

  it("reports the leftmost mutation keyword when several appear", () => {
    expect(checkReadOnly("INSERT INTO t VALUES (1)")).toEqual({
      ok: false,
      reason:
        '"INSERT" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
    expect(checkReadOnly("DROP TABLE t; DELETE FROM t")).toEqual({
      ok: false,
      reason:
        '"DROP" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it("reports a mutation keyword before a later dangerous function", () => {
    expect(checkReadOnly("DELETE FROM t; SELECT pg_sleep(1)")).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it.each(DANGEROUS_FUNCTIONS)(
    "rejects dangerous function %s() with the default write override",
    (fn) => {
      expect(checkReadOnly(`SELECT ${fn}()`)).toEqual({
        ok: false,
        reason: `"${reportedDangerousName(fn)}" is a dangerous function. Set allowWrites:true to execute.`,
      });
    },
  );

  it("names the earlier list prefix when a longer function contains a shorter one", () => {
    expect(checkReadOnly("SELECT pg_sleep_for('1s')")).toEqual({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
    expect(checkReadOnly("SELECT pg_advisory_unlock_all()")).toEqual({
      ok: false,
      reason:
        '"PG_ADVISORY_UNLOCK" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("rejects a mixed-case dangerous function and uppercases the name", () => {
    expect(checkReadOnly("SELECT Pg_SlEeP(10)")).toEqual({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("rejects a quoted dangerous function name", () => {
    expect(checkReadOnly("SELECT \"pg_read_file\"('/etc/passwd')")).toEqual({
      ok: false,
      reason:
        '"PG_READ_FILE" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("rejects a schema-qualified quoted dangerous function", () => {
    expect(checkReadOnly('SELECT "pg_catalog"."pg_sleep"(1)')).toEqual({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("rejects a dangerous function with whitespace before the parenthesis", () => {
    expect(checkReadOnly("SELECT nextval  ( 'seq' )")).toEqual({
      ok: false,
      reason:
        '"NEXTVAL" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("interpolates a custom write override into the dangerous-function reason", () => {
    expect(checkReadOnly("SELECT pg_sleep(1)", "writes=1")).toEqual({
      ok: false,
      reason: '"PG_SLEEP" is a dangerous function. Set writes=1 to execute.',
    });
  });

  it("reports a dangerous function before a later multi-statement semicolon", () => {
    expect(checkReadOnly("SELECT pg_sleep(1); SELECT 1")).toEqual({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("rejects multi-statement queries", () => {
    expect(checkReadOnly("SELECT 1; SELECT 2")).toEqual({
      ok: false,
      reason: "Multi-statement queries are not allowed in read-only mode.",
    });
  });

  it("rejects a second statement after a trailing-semicolon strip of only the last semicolon", () => {
    expect(checkReadOnly("SELECT 1;;")).toEqual({
      ok: false,
      reason: "Multi-statement queries are not allowed in read-only mode.",
    });
  });

  it("ignores a semicolon that lives only inside a string literal", () => {
    expect(checkReadOnly("SELECT ';' AS punctuation")).toEqual({ ok: true });
  });

  it("passes through an unterminated block comment from the scanner", () => {
    expect(checkReadOnly("SELECT 1 /* never closed")).toEqual({
      ok: false,
      reason: "Unterminated block comment.",
    });
  });

  it("passes through an unterminated string literal from the scanner", () => {
    expect(checkReadOnly("SELECT 'oops")).toEqual({
      ok: false,
      reason: "Unterminated string literal.",
    });
  });

  it("passes through an unterminated quoted identifier from the scanner", () => {
    expect(checkReadOnly('SELECT "oops')).toEqual({
      ok: false,
      reason: "Unterminated quoted identifier.",
    });
  });

  it("passes through an unterminated dollar-quoted string from the scanner", () => {
    expect(checkReadOnly("SELECT $tag$still open")).toEqual({
      ok: false,
      reason: "Unterminated dollar-quoted string.",
    });
  });

  it("passes through a unicode-escaped identifier rejection from the scanner", () => {
    expect(checkReadOnly('SELECT U&"\\0070g_sleep"(1)')).toEqual({
      ok: false,
      reason:
        'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    });
  });

  it("passes through an oversized dollar-quote tag from the scanner", () => {
    const tag = "a".repeat(129);
    expect(checkReadOnly(`SELECT $${tag}$x$`)).toEqual({
      ok: false,
      reason:
        "Dollar-quote tags longer than 128 characters are not allowed in read-only mode.",
    });
  });

  it("passes through the scanner's total-work budget", () => {
    expect(checkReadOnly(" ".repeat(MAX_READ_ONLY_SQL_LENGTH + 1))).toEqual({
      ok: false,
      reason: `Read-only SQL is limited to ${MAX_READ_ONLY_SQL_LENGTH} characters.`,
    });
  });

  it("still sees a mutation after a closed block comment splits the keyword", () => {
    expect(checkReadOnly("DE/* */LETE FROM memories")).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });
});
