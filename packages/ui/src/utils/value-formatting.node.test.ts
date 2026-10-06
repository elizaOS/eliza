import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMinorCurrency,
  isIsoCalendarDate,
  isOrderedIsoDateRange,
} from "./value-formatting.ts";

test("currency exponents and safe integer extremes retain every minor unit", () => {
  assert.equal(
    formatMinorCurrency({ amountMinor: 12345, currency: "USD" }, "en-US"),
    "$123.45",
  );
  assert.equal(
    formatMinorCurrency({ amountMinor: 12345, currency: "JPY" }, "en-US"),
    "¥12,345",
  );
  assert.equal(
    formatMinorCurrency({ amountMinor: 12345, currency: "KWD" }, "en-US"),
    "KWD\u00a012.345",
  );
  assert.equal(
    formatMinorCurrency(
      { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" },
      "en-US",
    ),
    "$90,071,992,547,409.91",
  );
  assert.equal(
    formatMinorCurrency(
      { amountMinor: Number.MIN_SAFE_INTEGER, currency: "USD" },
      "en-US",
    ),
    "-$90,071,992,547,409.91",
  );
  assert.equal(
    formatMinorCurrency({ amountMinor: -1, currency: "USD" }, "en-US"),
    "-$0.01",
  );
  assert.equal(
    formatMinorCurrency({ amountMinor: 0, currency: "USD" }, "en-US"),
    "$0.00",
  );
  assert.equal(
    formatMinorCurrency(
      { amountMinor: 12345, currency: "EUR", currencyDigits: 2 },
      "es-ES",
    ),
    "123,45\u00a0€",
  );
});
test("invalid amounts, currencies and mismatched exponents reject", () => {
  for (const amountMinor of [NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      formatMinorCurrency({ amountMinor, currency: "USD" }, "en-US"),
    );
  for (const currency of ["usd", "BAD", "", "US"])
    assert.throws(() =>
      formatMinorCurrency({ amountMinor: 1, currency }, "en-US"),
    );
  assert.throws(
    () =>
      formatMinorCurrency(
        { amountMinor: 1, currency: "JPY", currencyDigits: 2 },
        "en-US",
      ),
    /exponent/,
  );
});
test("canonical calendar dates reject normalized invalid days and non-date inputs", () => {
  for (const date of [
    "2024-02-29",
    "2000-02-29",
    "0000-01-01",
    "0099-12-31",
    "2026-01-01",
  ])
    assert.equal(isIsoCalendarDate(date), true);
  for (const date of [
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-1-01",
    "2026-01-01T00:00:00Z",
    "",
    null,
    1,
  ])
    assert.equal(isIsoCalendarDate(date), false);
  assert.equal(isOrderedIsoDateRange("2026-01-01", "2026-01-01"), true);
  assert.equal(isOrderedIsoDateRange("2026-01-01", "2026-02-01"), true);
  assert.equal(isOrderedIsoDateRange("2026-02-01", "2026-01-01"), false);
  assert.equal(isOrderedIsoDateRange("2026-02-29", "2026-03-01"), false);
});
