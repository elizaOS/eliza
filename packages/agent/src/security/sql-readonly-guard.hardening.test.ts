/**
 * Hardened unit coverage for checkReadOnly — closes gaps not covered by
 * database-readonly.test.ts (line comments, unicode identifiers, quoted
 * dangerous functions, multi-statement, unterminated constructs).
 */
import { describe, expect, it } from "vitest";
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

  it.each(["\r", "\r\n", "\u2028", "\u2029"])(
    "rejects mutation SQL after the %j line terminator",
    (terminator) => {
      expect(
        checkReadOnly(`SELECT 1 -- harmless${terminator}DELETE FROM secrets`),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("DELETE"),
      });
    },
  );

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

  it("ignores mutation keywords inside single-quoted strings", () => {
    expect(checkReadOnly("SELECT 'DELETE FROM x'")).toEqual({ ok: true });
  });

  it("ignores mutation keywords inside double-quoted identifiers", () => {
    // A column literally named "delete" is not a mutation.
    expect(checkReadOnly('SELECT "delete" FROM t')).toEqual({ ok: true });
  });

  it("treats nested-looking block comment per PG semantics (inner open leaves outer unterminated → remaining text is comment, ok)", () => {
    // PostgreSQL block comments nest: "/* inner /* */" leaves depth 1 open,
    // so "LETE FROM t" is still inside a comment → not executable SQL.
    expect(checkReadOnly("DE/* inner /* */ LETE FROM t")).toEqual({ ok: true });
  });

  it("rejects unterminated block comment followed by mutation text", () => {
    // Unterminated /* is preserved so following text is still scanned.
    expect(checkReadOnly("/* never closed\nDROP TABLE t")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("DROP"),
    });
  });

  it("ignores mutation keywords inside a closed tag-quoted dollar literal", () => {
    // $tag$...$tag$ is a complete literal; DELETE inside it is data, not SQL.
    expect(checkReadOnly("SELECT $tag$DELETE FROM memories$tag$")).toEqual({
      ok: true,
    });
  });
});
