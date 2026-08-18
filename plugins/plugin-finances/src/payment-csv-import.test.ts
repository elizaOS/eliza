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

  it("routes 'Amount Debit'/'Amount Credit' headers through the separate debit/credit path", () => {
    // Regression for #22263: both bank headers contain the "amount" substring,
    // so the AMOUNT fallback used to claim the debit column as a single signed
    // amount — reading the positive debit value as a credit and dropping the
    // credit-only row with a bogus "unparseable amount" error.
    const r = parseTransactionsCsv(
      "Date,Payee,Amount Debit,Amount Credit\n2026-01-15,Coffee,4.50,\n2026-01-16,Refund,,10.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.rowsRead).toBe(2);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
      merchantRaw: "Coffee",
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
      merchantRaw: "Refund",
    });
  });

  it("keeps a credit-only 'Amount Credit' row instead of dropping it", () => {
    const r = parseTransactionsCsv(
      "Date,Payee,Amount Debit,Amount Credit\n2026-02-01,Payroll,,2500.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "credit",
      amountUsd: 2500,
      merchantRaw: "Payroll",
    });
  });

  it("still classifies a single 'Amount' column by sign after the fix", () => {
    const r = parseTransactionsCsv(
      "Date,Amount,Merchant\n2026-01-15,-9.99,NETFLIX.COM\n2026-01-16,250.00,Paycheck\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 9.99,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 250,
    });
  });

  it("honors an explicit amountColumn even when it matches a debit hint", () => {
    // A user who deliberately points amountColumn at "Amount Debit" wants the
    // single-signed-amount branch; the collision guard must not override an
    // explicit option.
    const r = parseTransactionsCsv(
      "Date,Payee,Amount Debit,Amount Credit\n2026-01-15,Coffee,-4.50,\n",
      { amountColumn: "Amount Debit" },
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
  });

  it("normalizes US-format and 2-digit-year dates to a 2026 calendar date", () => {
    const r = parseTransactionsCsv("Date,Amount,Merchant\n1/16/26,-5,Gym\n");
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].postedAt).toBe("2026-01-16T00:00:00.000Z");
  });

  describe("timezone-deterministic date normalization", () => {
    // postedAt feeds buildTransactionId, so a date-only value must map to the
    // same UTC instant on every machine or re-imports from another timezone
    // double-count. Expected instants are therefore always constructed via
    // Date.UTC — never via `new Date(y, m, d)`, which would bake the test
    // runner's local offset into the expectation and hide the regression.
    const utcMidnight = (y: number, m: number, d: number) =>
      new Date(Date.UTC(y, m - 1, d)).toISOString();

    it("parses MM/DD/YYYY and ISO date-only values to the same UTC midnight", () => {
      const r = parseTransactionsCsv(
        "Date,Amount,Merchant\n01/02/2024,-12.34,Netflix\n2024-01-02,-9.99,Spotify\n",
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions[0].postedAt).toBe(utcMidnight(2024, 1, 2));
      expect(r.transactions[0].postedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(r.transactions[1].postedAt).toBe(r.transactions[0].postedAt);
    });

    it("keeps mixed-format rows for the same day on one UTC base", () => {
      const r = parseTransactionsCsv(
        'Date,Amount,Merchant\n1-2-24,-1,Dash\n"Jan 2, 2024",-1,Prose\n2024-01-02,-1,Iso\n',
      );
      expect(r.errors).toEqual([]);
      const stamps = new Set(r.transactions.map((t) => t.postedAt));
      expect(stamps).toEqual(new Set([utcMidnight(2024, 1, 2)]));
    });

    it("preserves native semantics for datetimes carrying Z or an offset", () => {
      const r = parseTransactionsCsv(
        "Date,Amount,Merchant\n2024-01-02T10:00:00Z,-1,Zulu\n2024-01-02T10:00:00-05:00,-1,Offset\n",
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions[0].postedAt).toBe("2024-01-02T10:00:00.000Z");
      expect(r.transactions[1].postedAt).toBe("2024-01-02T15:00:00.000Z");
    });

    it("preserves explicit zones on date-only RFC spellings", () => {
      const r = parseTransactionsCsv(
        'Date,Amount,Merchant\n"02 Jan 2024 GMT",-1,Zone\n',
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions[0].postedAt).toBe("2024-01-02T00:00:00.000Z");
    });

    it("still rejects unparseable dates", () => {
      const r = parseTransactionsCsv(
        "Date,Amount,Merchant\nnot-a-date,-1,Bad\n2024-99,-1,AlsoBad\n",
      );
      expect(r.transactions).toEqual([]);
      expect(r.errors.filter((e) => /unparseable date/.test(e))).toHaveLength(
        2,
      );
    });

    it("rejects an out-of-range month/day instead of letting Date.UTC roll it into a different date", () => {
      // A non-US bank export using DD/MM/YYYY ("13/05/2024" = 13 May) matches
      // the same digit-group regex as MM/DD/YYYY. Forced into month/day order,
      // month 13 doesn't exist; Date.UTC(2024, 12, 5) silently rolls that into
      // 2025-01-05 instead of erroring. Feb 31 (no such day) rolls the same way
      // into March. Both must be rejected, not silently mis-dated.
      const r = parseTransactionsCsv(
        "Date,Amount,Merchant\n13/05/2024,-1,BadMonthSlash\n02/31/2024,-1,BadDaySlash\n2024-13-05,-1,BadMonthIso\n2024-02-31,-1,BadDayIso\n0000-02-30,-1,BadYearZeroDay\n",
      );
      expect(r.transactions).toEqual([]);
      expect(r.errors.filter((e) => /unparseable date/.test(e))).toHaveLength(
        5,
      );
    });

    it("still accepts real calendar-edge dates", () => {
      const r = parseTransactionsCsv(
        "Date,Amount,Merchant\n12/31/2024,-1,YearEnd\n2024-02-29,-1,LeapDay\n02/29/2024,-1,LeapDaySlash\n0000-02-29,-1,YearZeroLeapDay\n0099-12-31,-1,TwoDigitCenturyYearEnd\n",
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions.map((t) => t.postedAt)).toEqual([
        utcMidnight(2024, 12, 31),
        utcMidnight(2024, 2, 29),
        utcMidnight(2024, 2, 29),
        "0000-02-29T00:00:00.000Z",
        "0099-12-31T00:00:00.000Z",
      ]);
    });

    it("yields a stable transaction-id key for a re-imported row", () => {
      // Mirrors buildTransactionId's hash key recipe (finances-service.ts):
      // postedAt is a hashed component, so determinism here is what keeps
      // CSV re-imports idempotent across machines in different timezones.
      const key = (t: { postedAt: string; amountUsd: number }) =>
        ["agent", "source", t.postedAt, t.amountUsd.toFixed(2)].join("|");
      const csv = "Date,Amount,Merchant\n01/02/2024,-12.34,Netflix\n";
      const first = parseTransactionsCsv(csv).transactions[0];
      const second = parseTransactionsCsv(csv).transactions[0];
      expect(key(second)).toBe(key(first));
      expect(first.postedAt).toBe(utcMidnight(2024, 1, 2));
    });
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

  it("early-returns when amount column is missing without generating redundant row errors", () => {
    const csv =
      "Date,Merchant\n2026-01-15,Netflix\n2026-01-16,Spotify\n2026-01-17,Apple\n";
    const r = parseTransactionsCsv(csv);
    expect(r.transactions).toEqual([]);
    expect(r.errors).toEqual([
      "Could not find an amount/debit/credit column in the CSV header.",
    ]);
  });

  it("flags a CSV with no data rows", () => {
    const r = parseTransactionsCsv("Date,Amount,Description\n");
    expect(r.transactions).toEqual([]);
    expect(r.errors).toContain("CSV has no data rows.");
  });
});
