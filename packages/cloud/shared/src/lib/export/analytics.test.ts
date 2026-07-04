// Exercises analytics behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercentage,
  generateCSV,
  generateJSON,
} from "./analytics";

/**
 * Analytics export. The CSV writer is a spreadsheet-formula-injection boundary:
 * a value beginning with =, +, -, @ (or tab/CR) must be neutralized with a
 * leading apostrophe so opening the export in Excel/Sheets can't execute it.
 * Values with commas/quotes must also be RFC-4180 quoted, and the numeric/date
 * formatters must degrade safely on junk input.
 */

const columns = [
  { key: "name", label: "Name" },
  { key: "note", label: "Note" },
];

describe("generateCSV — formula-injection guard", () => {
  test("prefixes dangerous leading chars with an apostrophe", () => {
    const csv = generateCSV([{ name: "=SUM(A1:A2)", note: "ok" }], columns);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Name,Note");
    expect(lines[1]).toBe("'=SUM(A1:A2),ok");
  });

  test("RFC-4180 quotes values containing commas or quotes", () => {
    const csv = generateCSV([{ name: "a,b", note: 'say "hi"' }], columns);
    const line = csv.split("\n")[1];
    expect(line).toBe('"a,b","say ""hi"""');
  });

  test("null/undefined cells render as empty strings", () => {
    const csv = generateCSV([{ name: null, note: undefined }], columns);
    expect(csv.split("\n")[1]).toBe(",");
  });
});

describe("generateJSON", () => {
  test("wraps data under a data key; metadata only when requested", () => {
    expect(JSON.parse(generateJSON([1, 2]))).toEqual({ data: [1, 2] });
    expect(JSON.parse(generateJSON([1, 2], { includeMetadata: true }))).toEqual({
      metadata: { totalRecords: 2 },
      data: [1, 2],
    });
  });
});

describe("formatters degrade safely", () => {
  test("formatCurrency converts cents and tolerates junk", () => {
    expect(formatCurrency(12345)).toBe("123.45");
    expect(formatCurrency("nope")).toBe("0.00");
  });

  test("formatNumber adds K/M suffixes", () => {
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1500)).toBe("1.5K");
    expect(formatNumber(2_000_000)).toBe("2.0M");
    expect(formatNumber("x")).toBe("0");
  });

  test("formatPercentage scales 0..1 to a percent", () => {
    expect(formatPercentage(0.25)).toBe("25.0%");
    expect(formatPercentage("x")).toBe("0.0%");
  });

  test("formatDate emits ISO for Date/string, empty for junk", () => {
    expect(formatDate(new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02T00:00:00.000Z");
    expect(formatDate("2026-01-02T00:00:00.000Z")).toBe("2026-01-02T00:00:00.000Z");
    expect(formatDate(42)).toBe("");
  });
});
