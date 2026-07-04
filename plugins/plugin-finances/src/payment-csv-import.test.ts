/**
 * Unit tests for the RFC 4180 CSV parser and bank/card transaction extraction
 * (`parseCsv`, `parseTransactionsCsv`) — column-hint detection, separate
 * debit/credit columns, and amount/direction normalization. Pure functions, no
 * I/O.
 */

import { describe, expect, it } from "vitest";
import { parseCsv, parseTransactionsCsv } from "./payment-csv-import.js";

describe("parseCsv (RFC 4180)", () => {
  it("splits simple rows and trims empties", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(parseCsv("a,b\n\n\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    expect(parseCsv('name,note\n"Doe, John","said ""hi"""')).toEqual([
      ["name", "note"],
      ["Doe, John", 'said "hi"'],
    ]);
  });

  it("handles CRLF and a quoted embedded newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv('x\n"line1\nline2"')).toEqual([["x"], ["line1\nline2"]]);
  });
});

describe("parseTransactionsCsv", () => {
  it("parses a canonical single-amount statement", () => {
    const r = parseTransactionsCsv(
      "Date,Amount,Description\n2026-01-15,-9.99,NETFLIX.COM\n2026-01-16,250.00,Paycheck\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.rowsRead).toBe(2);
    expect(r.transactions).toHaveLength(2);
    const [debit, credit] = r.transactions;
    expect(debit.direction).toBe("debit");
    expect(debit.amountUsd).toBe(9.99);
    expect(debit.merchantRaw).toBe("NETFLIX.COM");
    expect(debit.merchantNormalized).toBe("netflix");
    expect(debit.postedAt).toBe("2026-01-15T00:00:00.000Z");
    expect(credit.direction).toBe("credit");
  });

  it("supports separate debit/credit columns and accounting negatives", () => {
    // ISO dates parse to a deterministic UTC midnight (US/short formats go
    // through Date.parse, which is timezone-dependent — not asserted here).
    const r = parseTransactionsCsv(
      "Posted Date,Payee,Debit,Credit\n2026-01-15,Coffee,(4.50),\n2026-01-16,Refund,,10.00\n",
    );
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
    });
    expect(r.transactions[0].postedAt).toBe("2026-01-15T00:00:00.000Z");
  });

  it("normalizes US-format and 2-digit-year dates to a 2026 calendar date", () => {
    const r = parseTransactionsCsv("Date,Amount,Merchant\n1/16/26,-5,Gym\n");
    expect(r.transactions).toHaveLength(1);
    // Exact time is timezone-dependent via Date.parse; assert the year only.
    expect(r.transactions[0].postedAt).toMatch(/^2026-01-1[56]T/);
  });

  it("strips currency symbols and thousands separators", () => {
    const r = parseTransactionsCsv(
      'Date,Amount,Merchant\n2026-02-01,"-$1,234.56",Rent\n',
    );
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 1234.56,
    });
  });

  it("honors explicit column option overrides", () => {
    const r = parseTransactionsCsv("when,who,how_much\n2026-01-01,Gym,-30\n", {
      dateColumn: "when",
      merchantColumn: "who",
      amountColumn: "how_much",
    });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].merchantRaw).toBe("Gym");
  });

  it("reports per-row errors and skips bad rows without aborting", () => {
    const r = parseTransactionsCsv(
      "Date,Amount,Description\nnot-a-date,-5,A\n2026-01-02,xyz,B\n2026-01-03,,C\n2026-01-04,-7,Good\n",
    );
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].merchantRaw).toBe("Good");
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    expect(r.errors.some((e) => /unparseable date/.test(e))).toBe(true);
    expect(r.errors.some((e) => /unparseable amount/.test(e))).toBe(true);
  });

  it("reports missing required columns in the header", () => {
    const r = parseTransactionsCsv("foo,bar\n1,2\n");
    expect(r.transactions).toEqual([]);
    expect(r.errors.some((e) => /date column/.test(e))).toBe(true);
    expect(r.errors.some((e) => /amount\/debit\/credit/.test(e))).toBe(true);
    expect(r.errors.some((e) => /merchant/.test(e))).toBe(true);
  });

  it("flags a CSV with no data rows", () => {
    const r = parseTransactionsCsv("Date,Amount,Description\n");
    expect(r.transactions).toEqual([]);
    expect(r.errors).toContain("CSV has no data rows.");
  });
});
