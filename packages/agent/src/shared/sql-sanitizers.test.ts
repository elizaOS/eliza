/**
 * Behavioral unit coverage for the linear SQL sanitizers and the bounded
 * read-only scanner. Drives the real module: every exported helper, overflow
 * and unterminated paths, nested versus non-nested comments, dollar-quote
 * tag limits, and the three scanner text streams. Deterministic — no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_READ_ONLY_SQL_LENGTH,
  type ReadOnlySqlScan,
  scanSqlForReadOnly,
  stripSqlBlockComments,
  stripSqlDollarQuotedLiterals,
  stripSqlLineComments,
} from "./sql-sanitizers.ts";

describe("MAX_READ_ONLY_SQL_LENGTH", () => {
  it("is two mebibytes", () => {
    expect(MAX_READ_ONLY_SQL_LENGTH).toBe(2 * 1024 * 1024);
  });
});

describe("stripSqlBlockComments", () => {
  it("leaves empty and comment-free SQL unchanged", () => {
    expect(stripSqlBlockComments("")).toBe("");
    expect(stripSqlBlockComments("SELECT 1")).toBe("SELECT 1");
  });

  it("strips a terminated comment with empty replacement", () => {
    expect(stripSqlBlockComments("SELECT /* c */ 1")).toBe("SELECT  1");
  });

  it("concatenates tokens split by a comment", () => {
    expect(stripSqlBlockComments("DE/*x*/LETE")).toBe("DELETE");
  });

  it("strips multiple comments and empty /**/ pairs", () => {
    expect(stripSqlBlockComments("a/*x*/b/**/c")).toBe("abc");
  });

  it("closes at the first star-slash (non-nested)", () => {
    expect(stripSqlBlockComments("/* a /* b */ c */")).toBe(" c */");
  });

  it("preserves an unterminated opener and everything after it", () => {
    expect(stripSqlBlockComments("SELECT /* never closed DELETE")).toBe(
      "SELECT /* never closed DELETE",
    );
  });

  it("preserves a trailing opener with no closer", () => {
    expect(stripSqlBlockComments("SELECT 1 /*")).toBe("SELECT 1 /*");
  });

  it("does not treat a lone star as a closer", () => {
    expect(stripSqlBlockComments("SELECT /* a * b */ 1")).toBe("SELECT  1");
  });
});

describe("stripSqlLineComments", () => {
  it("leaves empty and comment-free SQL unchanged", () => {
    expect(stripSqlLineComments("")).toBe("");
    expect(stripSqlLineComments("SELECT 1")).toBe("SELECT 1");
  });

  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "strips through %j and keeps the terminator",
    (terminator) => {
      expect(
        stripSqlLineComments(`SELECT 1 -- noise${terminator}DELETE FROM t`),
      ).toBe(`SELECT 1 ${terminator}DELETE FROM t`);
    },
  );

  it("strips an unterminated line comment at end of input", () => {
    expect(stripSqlLineComments("SELECT 1 -- leftover")).toBe("SELECT 1 ");
  });

  it("strips a comment that is only dashes", () => {
    expect(stripSqlLineComments("--")).toBe("");
  });

  it("strips successive line comments", () => {
    expect(stripSqlLineComments("A -- x\nB -- y\nC")).toBe("A \nB \nC");
  });

  it("strips from the first -- even when it sits inside quote-looking text", () => {
    expect(stripSqlLineComments("SELECT '-- still' -- x\n1")).toBe(
      "SELECT '\n1",
    );
  });
});

describe("stripSqlDollarQuotedLiterals", () => {
  it("leaves empty SQL and lone dollars unchanged", () => {
    expect(stripSqlDollarQuotedLiterals("")).toBe("");
    expect(stripSqlDollarQuotedLiterals("SELECT $5")).toBe("SELECT $5");
    expect(stripSqlDollarQuotedLiterals("$")).toBe("$");
  });

  it("replaces a closed $$ literal with a space", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $$DELETE$$")).toBe("SELECT  ");
  });

  it("replaces a closed tagged literal with a space", () => {
    expect(
      stripSqlDollarQuotedLiterals("SELECT $tag_1$ALTER TABLE$tag_1$"),
    ).toBe("SELECT  ");
  });

  it("preserves an unterminated dollar literal including following SQL", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $tag$DELETE FROM t")).toBe(
      "SELECT $tag$DELETE FROM t",
    );
  });

  it("does not treat a mismatched tag as a closer", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $a$1$b$ SELECT $c$2$c$")).toBe(
      "SELECT $a$1$b$ SELECT $c$2$c$",
    );
  });

  it("does not open a quote on a tag that never gets its closing dollar", () => {
    expect(stripSqlDollarQuotedLiterals("$tag DELETE")).toBe("$tag DELETE");
  });

  it("does not recognize a tag longer than 128 identifier characters", () => {
    const long = `$${"a".repeat(129)}`;
    expect(stripSqlDollarQuotedLiterals(long)).toBe(long);
  });

  it("strips a 128-character tagged literal", () => {
    const tag = "a".repeat(128);
    expect(stripSqlDollarQuotedLiterals(`SELECT $${tag}$DROP$${tag}$`)).toBe(
      "SELECT  ",
    );
  });

  it("strips $$ even when it immediately follows an identifier", () => {
    expect(stripSqlDollarQuotedLiterals("a$$b$$")).toBe("a ");
  });
});

function expectOk(
  scan: ReadOnlySqlScan,
): asserts scan is Extract<ReadOnlySqlScan, { ok: true }> {
  expect(scan.ok).toBe(true);
}

describe("scanSqlForReadOnly", () => {
  it("returns empty streams for empty input", () => {
    expect(scanSqlForReadOnly("")).toEqual({
      ok: true,
      keywordText: "",
      callableText: "",
      structuralText: "",
    });
  });

  it("copies comment-free SQL into all three streams", () => {
    const sql = "SELECT 1 FROM t";
    expect(scanSqlForReadOnly(sql)).toEqual({
      ok: true,
      keywordText: sql,
      callableText: sql,
      structuralText: sql,
    });
  });

  it("rejects SQL longer than MAX_READ_ONLY_SQL_LENGTH", () => {
    const sql = "x".repeat(MAX_READ_ONLY_SQL_LENGTH + 1);
    expect(scanSqlForReadOnly(sql)).toEqual({
      ok: false,
      reason: `Read-only SQL is limited to ${MAX_READ_ONLY_SQL_LENGTH} characters.`,
    });
  });

  it("accepts SQL at exactly MAX_READ_ONLY_SQL_LENGTH", () => {
    const sql = "x".repeat(MAX_READ_ONLY_SQL_LENGTH);
    const scan = scanSqlForReadOnly(sql);
    expectOk(scan);
    expect(scan.keywordText).toBe(sql);
    expect(scan.keywordText.length).toBe(MAX_READ_ONLY_SQL_LENGTH);
  });

  it("replaces a line comment with a space and keeps the terminator", () => {
    const scan = scanSqlForReadOnly("SELECT 1 -- noise\nFROM t");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT 1  \nFROM t");
  });

  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"] as const)(
    "ends a line comment at %j",
    (terminator) => {
      const scan = scanSqlForReadOnly(
        `SELECT 1 -- noise${terminator}DELETE FROM t`,
      );
      expectOk(scan);
      expect(scan.keywordText).toContain("DELETE FROM t");
      expect(scan.keywordText).not.toContain("noise");
    },
  );

  it("replaces an unterminated line comment at EOF with a space", () => {
    const scan = scanSqlForReadOnly("SELECT 1 -- leftover");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT 1  ");
  });

  it("concatenates tokens split by a non-nested block comment", () => {
    const scan = scanSqlForReadOnly("DE/*x*/LETE FROM t");
    expectOk(scan);
    expect(scan.keywordText).toBe("DELETE FROM t");
  });

  it("nests block comments until depth returns to zero", () => {
    const scan = scanSqlForReadOnly("SELECT /* a /* b */ c */ 1");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  1");
  });

  it("rejects an unterminated block comment", () => {
    expect(scanSqlForReadOnly("SELECT /* never closed")).toEqual({
      ok: false,
      reason: "Unterminated block comment.",
    });
  });

  it("rejects an unterminated nested block comment", () => {
    expect(scanSqlForReadOnly("DE/* inner /* */ LETE")).toEqual({
      ok: false,
      reason: "Unterminated block comment.",
    });
  });

  it("treats $ after an identifier character as identifier text", () => {
    const scan = scanSqlForReadOnly("SELECT col$1");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT col$1");
    expect(scan.callableText).toBe("SELECT col$1");
  });

  it("does not open a dollar quote on $5", () => {
    const scan = scanSqlForReadOnly("SELECT $5");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT $5");
  });

  it("does not open a dollar quote when the tag never closes with $", () => {
    const scan = scanSqlForReadOnly("$tag DELETE");
    expectOk(scan);
    expect(scan.keywordText).toBe("$tag DELETE");
  });

  it("replaces a closed $$ literal with a space", () => {
    const scan = scanSqlForReadOnly("SELECT $$DELETE FROM t$$");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
    expect(scan.keywordText).not.toContain("DELETE");
  });

  it("replaces a closed tagged dollar literal with a space", () => {
    const scan = scanSqlForReadOnly("SELECT $body$ALTER TABLE$body$");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
  });

  it("does not treat $$ after an identifier as a dollar quote", () => {
    const scan = scanSqlForReadOnly("a$$b$$");
    expectOk(scan);
    expect(scan.keywordText).toBe("a$$b$$");
  });

  it("rejects an unterminated dollar-quoted string", () => {
    expect(scanSqlForReadOnly("SELECT $tag$DELETE")).toEqual({
      ok: false,
      reason: "Unterminated dollar-quoted string.",
    });
  });

  it("rejects a dollar-quote tag longer than 128 characters", () => {
    const tag = "a".repeat(129);
    expect(scanSqlForReadOnly(`$${tag}$x`)).toEqual({
      ok: false,
      reason:
        "Dollar-quote tags longer than 128 characters are not allowed in read-only mode.",
    });
  });

  it("accepts a 128-character dollar-quote tag", () => {
    const tag = "a".repeat(128);
    const scan = scanSqlForReadOnly(`SELECT $${tag}$DROP$${tag}$`);
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
  });

  it("replaces a single-quoted literal with a space", () => {
    const scan = scanSqlForReadOnly("SELECT 'DELETE FROM t'");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
    expect(scan.keywordText).not.toContain("DELETE");
  });

  it("treats doubled single quotes as escaped content, not a closer", () => {
    const scan = scanSqlForReadOnly("SELECT 'it''s fine'");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
  });

  it("rejects an unterminated string literal", () => {
    expect(scanSqlForReadOnly("SELECT 'oops")).toEqual({
      ok: false,
      reason: "Unterminated string literal.",
    });
  });

  it("strips the E/e prefix from escape-string literals", () => {
    const upper = scanSqlForReadOnly("SELECT E'foo'");
    expectOk(upper);
    expect(upper.keywordText).toBe("SELECT  ");

    const lower = scanSqlForReadOnly("SELECT e'foo'");
    expectOk(lower);
    expect(lower.keywordText).toBe("SELECT  ");
  });

  it("does not treat xe'...' as an escape-string prefix", () => {
    const scan = scanSqlForReadOnly("SELECT xe'foo'");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT xe ");
  });

  it("skips a backslash-escaped quote inside E'...'", () => {
    const scan = scanSqlForReadOnly("SELECT E'foo\\'bar'");
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  ");
  });

  it("rejects an unterminated escape string that ends on a backslash", () => {
    expect(scanSqlForReadOnly("SELECT E'foo\\")).toEqual({
      ok: false,
      reason: "Unterminated string literal.",
    });
  });

  it("puts decoded double-quoted identifiers only in callableText", () => {
    const scan = scanSqlForReadOnly('SELECT "pg_sleep"(1)');
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT  (1)");
    expect(scan.callableText).toBe("SELECT pg_sleep(1)");
    expect(scan.structuralText).toBe("SELECT  (1)");
  });

  it("decodes doubled double-quotes inside identifiers", () => {
    const scan = scanSqlForReadOnly('SELECT "a""b"');
    expectOk(scan);
    expect(scan.callableText).toBe('SELECT a"b');
    expect(scan.keywordText).toBe("SELECT  ");
  });

  it("rejects an unterminated quoted identifier", () => {
    expect(scanSqlForReadOnly('SELECT "oops')).toEqual({
      ok: false,
      reason: "Unterminated quoted identifier.",
    });
  });

  it('rejects Unicode-escaped identifiers U&"..." and u&"..."', () => {
    expect(scanSqlForReadOnly('SELECT U&"pg_sleep"')).toEqual({
      ok: false,
      reason:
        'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    });
    expect(scanSqlForReadOnly('SELECT u&"pg_sleep"')).toEqual({
      ok: false,
      reason:
        'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    });
  });

  it('does not treat xU&"..." as a unicode-escaped identifier', () => {
    const scan = scanSqlForReadOnly('SELECT xU&"foo"');
    expectOk(scan);
    expect(scan.keywordText).toBe("SELECT xU& ");
    expect(scan.callableText).toBe("SELECT xU&foo");
  });
});
