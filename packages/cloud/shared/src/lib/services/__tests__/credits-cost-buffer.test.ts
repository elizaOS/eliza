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

  test("accepts positive finite multipliers", () => {
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "1" })).toBe(1);
    expect(resolveCostBuffer({ CREDIT_COST_BUFFER: "2.25" })).toBe(2.25);
  });

  test.each(["0", "-1", "NaN", "Infinity"])(
    "rejects invalid operator configuration %s",
    (value) => {
      expect(() => resolveCostBuffer({ CREDIT_COST_BUFFER: value })).toThrow(
        "CREDIT_COST_BUFFER must be a positive finite number",
      );
    },
  );
});
