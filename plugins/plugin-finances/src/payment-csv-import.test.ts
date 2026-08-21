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

  it("treats a single 'Debit/Credit Amount' column as a signed amount", () => {
    // Regression for the collision-guard follow-up: this one physical column
    // matches the amount, debit, AND credit hints. It must stay on the signed
    // amount branch (sign decides direction) rather than being routed into the
    // separate debit/credit path, which classified every row as a debit.
    const r = parseTransactionsCsv(
      "Date,Payee,Debit/Credit Amount\n2026-01-15,Coffee,-4.50\n2026-01-16,Refund,10.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
    });
  });

  it("treats a single 'Credit Card Amount' column as a signed amount", () => {
    // "Credit Card Amount" matches both the amount and credit hints. The guard
    // must not force every row to "credit"; a negative value is still a debit.
    const r = parseTransactionsCsv(
      "Date,Payee,Credit Card Amount\n2026-01-15,Coffee,-4.50\n2026-01-16,Refund,10.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
    });
  });

  it("treats a single 'Debit/Credit' column (no 'amount' hint) as a signed amount", () => {
    // A lone column matching both direction hints but not the amount hint is
    // still a signed amount column; it must not collapse to a debit-only read.
    const r = parseTransactionsCsv(
      "Date,Payee,Debit/Credit\n2026-01-15,Coffee,-4.50\n2026-01-16,Refund,10.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
    });
  });

  it("treats a lone 'Amount Debit' column as one-sided debit, not signed", () => {
    // Regression for the re-review at 66739d13: a single directional column
    // must classify every row by the header's declared direction, not by sign.
    // The prior guard dropped the amount index onto the signed branch, so a
    // positive debit value was wrongly reported as a credit.
    const r = parseTransactionsCsv(
      "Date,Payee,Amount Debit\n2026-01-15,Coffee,4.50\n2026-01-16,Gas,20.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
    expect(r.transactions[1]).toMatchObject({
      direction: "debit",
      amountUsd: 20,
    });
  });

  it("treats a lone 'Debit Amount' column as one-sided debit", () => {
    const r = parseTransactionsCsv(
      "Date,Payee,Debit Amount\n2026-01-15,Coffee,4.50\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 4.5,
    });
  });

  it("treats a lone 'Withdrawal Amount' column as one-sided debit", () => {
    const r = parseTransactionsCsv(
      "Date,Payee,Withdrawal Amount\n2026-01-15,ATM,60.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "debit",
      amountUsd: 60,
    });
  });

  it("treats a lone 'Amount Credit' column as one-sided credit", () => {
    const r = parseTransactionsCsv(
      "Date,Payee,Amount Credit\n2026-02-01,Payroll,2500.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "credit",
      amountUsd: 2500,
    });
  });

  it("treats a lone 'Deposit Amount' column as one-sided credit", () => {
    const r = parseTransactionsCsv(
      "Date,Payee,Deposit Amount\n2026-02-01,Refund,10.00\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      direction: "credit",
      amountUsd: 10,
    });
  });

  it("treats one-sided directional columns with descriptive amount tokens as one-sided, not signed", () => {
    // Regression for the re-review at 123d1980: classifyDirectionColumn must not
    // infer signedness from arbitrary extra words. A header with exactly one
    // direction family plus a descriptor token ("transaction") that also matches
    // the parser's "transaction amount" hint is still a one-sided column, so a
    // positive value keeps the header's declared direction on every row.
    const debitHeaders = [
      "Debit Transaction Amount",
      "Transaction Amount Debit",
      "Withdrawal Transaction Amount",
    ];
    for (const headerCell of debitHeaders) {
      const r = parseTransactionsCsv(
        `Date,Payee,${headerCell}\n2026-01-15,Coffee,4.50\n2026-01-16,Gas,20.00\n`,
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions).toHaveLength(2);
      expect(r.transactions[0]).toMatchObject({
        direction: "debit",
        amountUsd: 4.5,
      });
      expect(r.transactions[1]).toMatchObject({
        direction: "debit",
        amountUsd: 20,
      });
    }

    const creditHeaders = [
      "Credit Transaction Amount",
      "Transaction Amount Credit",
      "Deposit Transaction Amount",
    ];
    for (const headerCell of creditHeaders) {
      const r = parseTransactionsCsv(
        `Date,Payee,${headerCell}\n2026-02-01,Payroll,2500.00\n`,
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions).toHaveLength(1);
      expect(r.transactions[0]).toMatchObject({
        direction: "credit",
        amountUsd: 2500,
      });
    }
  });

  it("keeps 'Credit Card Amount'/'Debit Card Amount' compound descriptors as signed", () => {
    // The narrowly reviewed compound-descriptor rule: "credit"/"debit" here name
    // a card noun, not a direction, so the sign of each value decides direction.
    for (const headerCell of [
      "Credit Card Amount",
      "Credit-Card Amount",
      "Credit_Card Amount",
      "Credit  Card Amount",
      "Debit Card Amount",
      "Debit-Card Amount",
      "Debit_Card Amount",
      "Debit  Card Amount",
      "Debit/Credit Card Amount",
      "Debit / Credit Card Amount",
      "Credit/Debit Card Amount",
      "Credit / Debit Card Amount",
      "Debit-Credit Card Amount",
      "Credit-Debit Card Amount",
      "Debit_Credit Card Amount",
      "Credit_Debit Card Amount",
      "Debit & Credit Card Amount",
      "Credit & Debit Card Amount",
      "Debit and Credit Card Amount",
      "Credit and Debit Card Amount",
      "Debit Credit Card Amount",
      "Credit Debit Card Amount",
    ]) {
      const r = parseTransactionsCsv(
        `Date,Payee,${headerCell}\n2026-01-15,Coffee,-4.50\n2026-01-16,Refund,10.00\n`,
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions).toHaveLength(2);
      expect(r.transactions[0]).toMatchObject({
        direction: "debit",
        amountUsd: 4.5,
      });
      expect(r.transactions[1]).toMatchObject({
        direction: "credit",
        amountUsd: 10,
      });
    }
  });

  it("classifies a card descriptor with adversarial separator whitespace", () => {
    const headerCell = `Credit${"\t".repeat(100_000)}Card Amount`;
    const result = parseTransactionsCsv(
      `Date,Payee,${headerCell}\n2026-01-15,Coffee,-4.50\n2026-01-16,Refund,10.00\n`,
    );
    expect(result.errors).toEqual([]);
    expect(
      result.transactions.map(({ direction, amountUsd }) => ({
        direction,
        amountUsd,
      })),
    ).toEqual([
      { direction: "debit", amountUsd: 4.5 },
      { direction: "credit", amountUsd: 10 },
    ]);
  });

  it("preserves an explicit direction outside a card descriptor", () => {
    const cases = [
      ["Credit Card Debit Amount", "debit"],
      ["Debit Card Credit Amount", "credit"],
    ] as const;
    for (const [headerCell, direction] of cases) {
      const r = parseTransactionsCsv(
        `Date,Payee,${headerCell}\n2026-01-15,Adjustment,10.00\n`,
      );
      expect(r.errors).toEqual([]);
      expect(r.transactions).toHaveLength(1);
      expect(r.transactions[0]).toMatchObject({
        direction,
        amountUsd: 10,
      });
    }
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
