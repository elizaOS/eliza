/**
 * Hardened unit coverage for checkReadOnly — closes gaps not covered by
 * database-readonly.test.ts (line comments, unicode identifiers, quoted
 * dangerous functions, multi-statement, unterminated constructs).
 */
import { describe, expect, it } from "vitest";
import { MAX_READ_ONLY_SQL_LENGTH } from "../shared/sql-sanitizers.ts";
import { checkReadOnly } from "./sql-readonly-guard.ts";

describe("checkReadOnly hardening", () => {
  it("rejects mutation keyword hidden after a -- line comment continuation", () => {
    // `--` comment strips to end of line; keyword on the next line must still
    // be caught (not hidden by the previous line's comment).
    expect(
      checkReadOnly("SELECT 1 -- benign\nDELETE FROM memories"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("DELETE"),
    });
  });

  it("does not start a line comment inside a string literal", () => {
    expect(
      checkReadOnly("SELECT 'value--'; DELETE FROM memories"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("DELETE"),
    });
  });

  it.each(["\r", "\r\n", "\n"])(
    "recognizes %j as a line-comment terminator",
    (lineEnding) => {
      expect(
        checkReadOnly(`SELECT 1 -- comment${lineEnding}DELETE FROM memories`),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("DELETE"),
      });
    },
  );

  it("handles PostgreSQL escape strings without treating their contents as SQL", () => {
    expect(checkReadOnly(String.raw`SELECT E'value\'--still data'`)).toEqual({
      ok: true,
    });
  });

  it('rejects unicode-escaped identifiers (U&"...") that can hide dangerous functions', () => {
    expect(
      checkReadOnly("SELECT U&\"\\0070g_read_file\"('/etc/passwd')"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unicode-escaped identifiers"),
    });
    // lowercase u& form too
    expect(checkReadOnly('SELECT u&"\\0070g_sleep"(10)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unicode-escaped identifiers"),
    });
  });

  it("rejects quoted dangerous function names (double-quoted identifiers)", () => {
    expect(checkReadOnly('SELECT "pg_sleep"(10)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining("PG_SLEEP"),
    });
  });

  it("rejects schema-qualified quoted dangerous function names", () => {
    expect(checkReadOnly('SELECT "pg_catalog"."pg_sleep"(10)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining("PG_SLEEP"),
    });
  });

  it("rejects mixed-case dangerous function names", () => {
    expect(checkReadOnly("SELECT Pg_SlEeP(10)")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("PG_SLEEP"),
    });
  });

  it("rejects dangerous functions with whitespace before the paren", () => {
    expect(checkReadOnly("SELECT pg_sleep  (10)")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("PG_SLEEP"),
    });
  });

  it("rejects multi-statement queries", () => {
    expect(checkReadOnly("SELECT 1; SELECT 2")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Multi-statement"),
    });
  });

  it("allows a single trailing semicolon", () => {
    expect(checkReadOnly("SELECT 1;")).toEqual({ ok: true });
  });

  it("ignores semicolons inside literals", () => {
    expect(checkReadOnly("SELECT ';' AS punctuation")).toEqual({ ok: true });
  });

  it("ignores mutation keywords inside single-quoted strings", () => {
    expect(checkReadOnly("SELECT 'DELETE FROM x'")).toEqual({ ok: true });
  });

  it("ignores mutation keywords inside double-quoted identifiers", () => {
    // A column literally named "delete" is not a mutation.
    expect(checkReadOnly('SELECT "delete" FROM t')).toEqual({ ok: true });
  });

  it("rejects an unterminated nested block comment", () => {
    expect(checkReadOnly("DE/* inner /* */ LETE FROM t")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unterminated block comment"),
    });
  });

  it("rejects unterminated block comment followed by mutation text", () => {
    // Unterminated /* is preserved so following text is still scanned.
    expect(checkReadOnly("/* never closed\nDROP TABLE t")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unterminated block comment"),
    });
  });

  it("rejects many unique unmatched dollar tags in bounded time", () => {
    const sql = Array.from(
      { length: 50_000 },
      (_, index) => `$tag${index}$x`,
    ).join("");
    const startedAt = performance.now();
    expect(checkReadOnly(sql)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unterminated dollar-quoted string"),
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects input above the scanner's total-work budget", () => {
    expect(
      checkReadOnly(" ".repeat(MAX_READ_ONLY_SQL_LENGTH + 1)),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("limited"),
    });
  });

  it("does not treat a dollar-like sequence inside an identifier as a literal", () => {
    expect(
      checkReadOnly("SELECT name$tag$DELETE$tag$ FROM records"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("DELETE"),
    });
  });

  it("ignores mutation keywords inside a closed tag-quoted dollar literal", () => {
    // $tag$...$tag$ is a complete literal; DELETE inside it is data, not SQL.
    expect(checkReadOnly("SELECT $tag$DELETE FROM memories$tag$")).toEqual({
      ok: true,
    });
  });
});
