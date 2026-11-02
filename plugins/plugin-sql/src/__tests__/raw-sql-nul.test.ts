/**
 * Raw-SQL literals must never carry U+0000: PostgreSQL rejects it in text and
 * a raw NUL truncates the statement at the wire protocol.
 */
import { describe, expect, it } from "vitest";
import { sqlJson, sqlQuote, sqlText } from "../database-utils/raw-sql";

const NUL = String.fromCharCode(0);

describe("raw-sql literals and U+0000", () => {
  it("drops U+0000 from quoted literals", () => {
    expect(sqlQuote(`Run${NUL} a marathon`)).toBe("'Run a marathon'");
    expect(sqlText(`a${NUL}${NUL}b`)).toBe("'ab'");
    expect(sqlQuote(`${NUL}`)).toBe("''");
  });

  it("still escapes single quotes and leaves other text unchanged", () => {
    expect(sqlQuote("O'Brien")).toBe("'O''Brien'");
    expect(sqlQuote(`O'Br${NUL}ien`)).toBe("'O''Brien'");
    expect(sqlQuote("tab\tand\nnewline")).toBe("'tab\tand\nnewline'");
    expect(sqlText(null)).toBe("NULL");
  });

  it("keeps JSON's escaped form untouched (only raw U+0000 is dropped)", () => {
    // JSON.stringify already escapes U+0000 as the six characters \u0000,
    // which a text column stores fine; sqlJson must not alter that.
    expect(sqlJson({ note: `a${NUL}b` })).toBe(`'{"note":"a\\u0000b"}'`);
  });
});
