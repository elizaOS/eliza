/**
 * Covers the stageable `@elizaos/ui/value-formatting.mjs` entry that native
 * hosts copy on its own: it must stay import-free and keep exact display math.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatMinorCurrency,
  isIsoCalendarDate,
  isOrderedIsoDateRange,
} from "./value-formatting.mjs";

describe("value-formatting.mjs", () => {
  it("is the import-free file behind the package export", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const entry = packageJson.exports["./value-formatting.mjs"];
    expect(entry["eliza-source"]).toBe("./src/utils/value-formatting.mjs");
    expect(entry.import).toBe("./dist/utils/value-formatting.mjs");
    expect(entry.types).toBe("./dist/utils/value-formatting.d.mts");
    const source = readFileSync(
      new URL("./value-formatting.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*(import|export\s[^;]*\sfrom)\b/m);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it("formats every minor unit of a safe integer amount", () => {
    expect(
      formatMinorCurrency(
        { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" },
        "en-US",
      ),
    ).toBe("$90,071,992,547,409.91");
    expect(
      formatMinorCurrency({ amountMinor: -5, currency: "USD" }, "en-US"),
    ).toBe("-$0.05");
    expect(
      formatMinorCurrency(
        { amountMinor: 1234, currency: "JPY", currencyDigits: 0 },
        "en-US",
      ),
    ).toBe("¥1,234");
  });

  it("rejects unsafe amounts, unknown currencies and a wrong exponent", () => {
    expect(() =>
      formatMinorCurrency(
        { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" },
        "en-US",
      ),
    ).toThrow("Invalid money value");
    expect(() =>
      formatMinorCurrency({ amountMinor: 1.5, currency: "USD" }, "en-US"),
    ).toThrow("Invalid money value");
    expect(() =>
      formatMinorCurrency({ amountMinor: 1, currency: "usd" }, "en-US"),
    ).toThrow("Invalid money value");
    expect(() =>
      formatMinorCurrency({ amountMinor: 1, currency: "ZZZ" }, "en-US"),
    ).toThrow("Invalid money value");
    expect(() =>
      formatMinorCurrency(
        { amountMinor: 1, currency: "USD", currencyDigits: 0 },
        "en-US",
      ),
    ).toThrow("Currency exponent does not match the amount");
  });

  it("accepts only canonical calendar dates", () => {
    expect(isIsoCalendarDate("2024-02-29")).toBe(true);
    expect(isIsoCalendarDate("2023-02-29")).toBe(false);
    expect(isIsoCalendarDate("2024-04-31")).toBe(false);
    expect(isIsoCalendarDate("2024-13-01")).toBe(false);
    expect(isIsoCalendarDate("2024-1-01")).toBe(false);
    expect(isIsoCalendarDate("2024-01-01T00:00:00Z")).toBe(false);
    expect(isIsoCalendarDate(20240101)).toBe(false);
  });

  it("accepts inclusive ordered ranges and rejects reversed or invalid ones", () => {
    expect(isOrderedIsoDateRange("2024-01-01", "2024-01-01")).toBe(true);
    expect(isOrderedIsoDateRange("2023-12-31", "2024-01-01")).toBe(true);
    expect(isOrderedIsoDateRange("2024-01-02", "2024-01-01")).toBe(false);
    expect(isOrderedIsoDateRange("2023-02-29", "2023-03-01")).toBe(false);
    expect(isOrderedIsoDateRange("2024-01-01", undefined)).toBe(false);
  });
});
