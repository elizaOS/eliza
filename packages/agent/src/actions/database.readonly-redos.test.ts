/**
 * Covers the DATABASE action's read-only SQL guard on adversarial input. The
 * guard receives model-produced SQL, so comment and dollar-quote stripping must
 * be linear and must leave malformed SQL visible to the mutation scanner.
 */
import { describe, expect, it } from "vitest";

import { checkReadOnly } from "./database.ts";

describe("DATABASE read-only SQL guard", () => {
  it("rejects mutation keywords split by block comments", () => {
    const result = checkReadOnly("DE/* invisible */LETE FROM memories");

    expect(result).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it("rejects mutation keywords in unterminated dollar-quoted input quickly", () => {
    const sql = `${Array.from({ length: 50_000 }, (_, i) => `$tag${i}$x`).join(
      "",
    )} DELETE FROM memories`;

    const start = performance.now();
    const result = checkReadOnly(sql);
    const elapsed = performance.now() - start;

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain('"DELETE"');
    }
    expect(elapsed).toBeLessThan(1000);
  });

  it("blocks dangerous functions hidden behind unicode-escaped identifiers", () => {
    // `U&"s\0065tval"` decodes to setval() at PG parse time — a sequence write
    // that a literal-name scan of the raw text misses. Confirmed executable in
    // PGlite before this guard. Every dangerous function is reachable this way.
    for (const sql of [
      `SELECT U&"s\\0065tval"('s', 999)`,
      `SELECT U&"pg_sl\\0065ep"(0.15)`,
      `SELECT U&"pg_wr\\0069te_file"('/tmp/x', 'data')`,
      `SELECT u&"lo_exp\\006Frt"(1, '/tmp/x')`, // lower-case u& is valid too
    ]) {
      const result = checkReadOnly(sql);
      expect(result, sql).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.reason).toContain("Unicode-escaped identifiers");
      }
    }
  });

  it("still allows ordinary read-only queries (no false positives)", () => {
    // A stray `U&` that is not the unicode-escape identifier syntax (space
    // before the quote, or inside a string literal) must not trip the guard.
    for (const sql of [
      "SELECT id, name FROM users WHERE active = true LIMIT 10",
      `SELECT "user" AS u FROM accounts`, // plain quoted identifier
      `SELECT 'contains U&\\" text' AS note`, // U&" inside a string literal
    ]) {
      expect(checkReadOnly(sql), sql).toEqual({ ok: true });
    }
  });
});
