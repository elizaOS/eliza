/**
 * Canonical earnings-unit boundary tests (#22960).
 *
 * Pins the unit canon: stored/ledgered earnings are USD (NUMERIC(18,4),
 * Decimal); "points" are a redemption HTTP-boundary representation only
 * (100 points = $1.00). Every conversion must round-trip exactly and every
 * serialization must survive without value drift.
 */
import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { REDEMPTION_MAX_POINTS, REDEMPTION_MIN_POINTS } from "../../../types/redemption-contract";
import { pointsFromUsd, REDEMPTION_POINTS_PER_USD, usdFromPoints } from "../earnings-units";

describe("usdFromPoints (API boundary -> canonical USD)", () => {
  test("integer points convert exactly with no float drift", () => {
    expect(usdFromPoints(100).toString()).toBe("1");
    expect(usdFromPoints(1).toString()).toBe("0.01");
    expect(usdFromPoints(12345).toString()).toBe("123.45");
    expect(usdFromPoints(REDEMPTION_MAX_POINTS).toString()).toBe("1000");
  });

  test("the 100-point boundary is exactly $1 (not 100 stored units)", () => {
    // The core #22960 invariant: 100 points debits exactly $1.0000 from a
    // USD balance — the off-by-100x misread this issue exists to prevent.
    expect(usdFromPoints(100).equals(new Decimal("1.0000"))).toBe(true);
  });

  test("fails closed on non-integer points with a typed error", () => {
    expect(() => usdFromPoints(100.5)).toThrow(/integer/);
    expect(() => usdFromPoints(NaN)).toThrow(/integer/);
    expect(() => usdFromPoints(Infinity)).toThrow(/integer/);
    // Typed-error policy: the failure carries an actionable code.
    try {
      usdFromPoints(100.5);
    } catch (e) {
      const err = e as { code?: string };
      expect(err.code).toBe("INVALID_REDEMPTION_POINTS");
    }
  });

  test("large points stay exact where float math would drift", () => {
    // 0.07-style drift class: 12,345,678 points = $123,456.78 exactly.
    expect(usdFromPoints(12_345_678).toString()).toBe("123456.78");
  });
});

describe("pointsFromUsd (canonical USD -> API boundary)", () => {
  test("whole-cent USD maps to integer points", () => {
    expect(pointsFromUsd(new Decimal("1"))).toBe(100);
    expect(pointsFromUsd(new Decimal("1.00"))).toBe(100);
    expect(pointsFromUsd(new Decimal("123.45"))).toBe(12345);
    expect(pointsFromUsd(new Decimal("1000.0000"))).toBe(100_000);
  });

  test("sub-cent USD (3+ decimals) returns null — the boundary is integer points", () => {
    expect(pointsFromUsd(new Decimal("1.005"))).toBeNull();
    expect(pointsFromUsd(new Decimal("0.0001"))).toBeNull();
  });

  test("rejects negative, non-finite, and malformed inputs without throwing", () => {
    expect(pointsFromUsd(new Decimal("-1"))).toBeNull();
    expect(pointsFromUsd(new Decimal("NaN"))).toBeNull();
    expect(pointsFromUsd(new Decimal("Infinity"))).toBeNull();
    expect(pointsFromUsd(Number.NaN)).toBeNull();
    expect(pointsFromUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("round-trips exactly for the full redemption range", () => {
    for (const pts of [
      REDEMPTION_MIN_POINTS,
      1_234,
      REDEMPTION_EVM_THRESHOLD_FOR_TEST(),
      REDEMPTION_MAX_POINTS,
    ]) {
      expect(pointsFromUsd(usdFromPoints(pts))).toBe(pts);
    }
  });
});

function REDEMPTION_EVM_THRESHOLD_FOR_TEST() {
  return 10_000;
}

describe("serialization: NUMERIC(18,4) string round-trip", () => {
  test("USD Decimal survives the NUMERIC string round-trip without drift", () => {
    // What actually happens at the DB boundary: Decimal -> string ->
    // Postgres NUMERIC(18,4) -> string -> Decimal.
    for (const pts of [100, 9_999, 10_000, 100_000]) {
      const usd = usdFromPoints(pts);
      const stored = usd.toFixed(4); // NUMERIC(18,4) write
      const read = new Decimal(stored); // read-back
      expect(read.equals(usd)).toBe(true);
      expect(pointsFromUsd(read)).toBe(pts);
    }
  });

  test("fractional 4dp earnings values parse losslessly", () => {
    // Earnings are credited at 4dp (e.g. markup splits). They must survive
    // serialization exactly — never float-rounded.
    for (const v of ["0.6701", "1.0001", "0.0001", "999.9999"]) {
      const d = new Decimal(v);
      expect(new Decimal(d.toFixed(4)).equals(d)).toBe(true);
    }
  });

  test("JS-number responses (quote/list paths) stay on the exact ratio grid", () => {
    // The API serializes some USD values as JSON numbers; integer-points
    // conversions are exactly representable, so no drift is acceptable.
    for (const pts of [100, 500, 1_234, 99_999]) {
      expect(usdFromPoints(pts).toNumber() * 100).toBe(pts);
    }
  });
});

describe("conversion contract: single source of truth", () => {
  test("ratio is exactly 100 and matches the SDK contract constant", () => {
    expect(REDEMPTION_POINTS_PER_USD).toBe(100);
  });
});
