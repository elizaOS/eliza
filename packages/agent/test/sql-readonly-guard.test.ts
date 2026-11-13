/**
 * Read-only SQL pre-filter: lexer edge cases where the scanner must read the
 * text the way PostgreSQL does, the leading-statement allowlist, and the
 * functions a READ ONLY transaction does not stop.
 */
import { describe, expect, it } from "vitest";
import { checkReadOnly } from "../src/security/sql-readonly-guard.ts";
import { stripSqlLineComments } from "../src/shared/sql-sanitizers.ts";

function refusal(sqlText: string): string {
  const guard = checkReadOnly(sqlText);
  if (guard.ok) throw new Error(`accepted: ${sqlText}`);
  return guard.reason;
}

describe("lexer", () => {
  it("reads $ after a non-ASCII identifier char as part of the identifier", () => {
    expect(refusal("SELECT 1 AS é$a$, nextval('s') AS b$a$")).toContain(
      "NEXTVAL",
    );
  });

  it("refuses a string continuation after an E-string", () => {
    expect(refusal("SELECT E'a'\n'b'")).toContain("E-string");
    expect(refusal("SELECT E'a' -- note\n'b'")).toContain("E-string");
    expect(checkReadOnly("SELECT 'a'\n'b'").ok).toBe(true);
  });

  it("ends -- comments only at \\n or \\r", () => {
    expect(checkReadOnly("SELECT 1 -- note\f nextval('s')").ok).toBe(true);
    expect(refusal("SELECT 1 -- '\n; SELECT nextval('s') --'")).toBeTruthy();
    expect(stripSqlLineComments("a -- x b\nc")).toBe("a \nc");
    expect(stripSqlLineComments("a -- x\rc")).toBe("a \rc");
  });

  it("never mentions a write override in a refusal", () => {
    for (const sqlText of [
      "DELETE FROM t",
      "SELECT nextval('s')",
      "SELECT 1; SELECT 2",
    ]) {
      expect(refusal(sqlText)).not.toMatch(/allowWrites|readOnly/);
    }
  });
});

describe("leading-statement allowlist", () => {
  it.each([
    "INSERT INTO t VALUES (1)",
    "CALL p()",
    "DO $$ BEGIN END $$",
    "SET search_path TO x",
    "COPY t TO STDOUT",
    "EXPLAIN ANALYZE SELECT 1",
    "EXPLAIN (ANALYZE) DELETE FROM t",
  ])("refuses %s", (sqlText) => {
    expect(checkReadOnly(sqlText).ok).toBe(false);
  });

  it.each([
    "SELECT 1",
    "(SELECT 1) UNION (SELECT 2)",
    "WITH a AS (SELECT 1) SELECT * FROM a",
    "SHOW server_version",
    "EXPLAIN SELECT 1",
    "VALUES (1), (2)",
    "TABLE notes",
    "/* why */ select 1;",
  ])("accepts %s", (sqlText) => {
    expect(checkReadOnly(sqlText).ok).toBe(true);
  });

  it("accepts identifiers named comment or set", () => {
    expect(checkReadOnly('SELECT comment, "set", t.set FROM notes t').ok).toBe(
      true,
    );
  });
});

describe("functions READ ONLY still allows", () => {
  it.each([
    ["SELECT nextval('s')", "NEXTVAL"],
    ["SELECT pg_notify('c', 'x')", "PG_NOTIFY"],
    ["SELECT set_config('a.b', 'c', false)", "SET_CONFIG"],
    ["SELECT * FROM public.dblink('x', 'y') AS t(a int)", "DBLINK"],
    ["SELECT query_to_xml('select 1', true, true, '')", "QUERY_TO_XML"],
    ['SELECT "pg_sleep"(1)', "PG_SLEEP"],
  ])("refuses %s", (sqlText, name) => {
    expect(refusal(sqlText)).toContain(name);
  });
});
