/**
 * Validates the credit reservation buffer configuration before billing paths
 * use it to size balance holds and inference admission requirements.
 */

import { describe, expect, test } from "bun:test";
import { resolveCostBuffer } from "../credits-config";

describe("resolveCostBuffer", () => {
  test("uses the documented default when the setting is absent or blank", () => {
    expect(resolveCostBuffer({})).toBe(1.5);
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "  " })).toBe(1.5);
  });

  test("accepts multipliers within the documented [1, 1000] domain", () => {
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "1" })).toBe(1);
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "2.25" })).toBe(2.25);
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "1000" })).toBe(1000);
  });

  test.each(["0", "-1", "NaN", "Infinity", "0.5", "0.999", "1000.1", "1001"])(
    "rejects operator configuration outside [1, 1000] or non-canonical: %s",
    (value) => {
      expect(() => resolveCostBuffer({ CREDIT_COST_BUFFER: value })).toThrow(
        /CREDIT_COST_BUFFER must be a canonical decimal number from 1 through 1000/,
      );
    },
  );

  test("rejects non-canonical spellings even when Number() would parse them", () => {
    // One auditable operator spelling excludes exponent notation, signs,
    // omitted integer parts, separators, and redundant leading zeroes.
    for (const value of ["1e1", "+10", ".5", "1_000", "01", "0001.5"]) {
      expect(() => resolveCostBuffer({ CREDIT_COST_BUFFER: value })).toThrow(
        /CREDIT_COST_BUFFER must be a canonical decimal number from 1 through 1000/,
      );
    }
  });

  test("throws an ElizaError carrying the stable code and context", () => {
    try {
      resolveCostBuffer({ CREDIT_COST_BUFFER: "0.5" });
      throw new Error("expected resolveCostBuffer to throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("INVALID_CREDIT_COST_BUFFER");
      expect((error as { context?: object }).context).toMatchObject({
        configured: "0.5",
        minimum: 1,
        maximum: 1000,
      });
    }
  });
});
