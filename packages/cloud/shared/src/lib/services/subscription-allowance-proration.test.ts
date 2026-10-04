import { expect, test } from "bun:test";
import { proratedAllowanceIncrease } from "./subscription-allowance-proration";

const period = {
  previousUsd: "25.000000",
  targetUsd: "90.000000",
  periodStartMs: 1000,
  periodEndMs: 7000,
};
test("full, half and fractional final-micro allowance use one exact rounding", () => {
  expect(proratedAllowanceIncrease({ ...period, effectiveAtMs: 1000 })).toBe("65.000000");
  expect(proratedAllowanceIncrease({ ...period, effectiveAtMs: 4000 })).toBe("32.500000");
  expect(proratedAllowanceIncrease({ ...period, effectiveAtMs: 6999 })).toBe("0.010833");
  expect(
    proratedAllowanceIncrease({ ...period, targetUsd: "25.000001", effectiveAtMs: 6999 }),
  ).toBe("0.000000");
});
test("invalid periods, expired reviews and noncanonical or decreasing amounts are rejected", () => {
  for (const change of [
    { effectiveAtMs: 7000 },
    { effectiveAtMs: 999 },
    { effectiveAtMs: 1000.5 },
    { periodEndMs: 1000 },
    { periodStartMs: NaN },
    { previousUsd: "25.0" },
    { targetUsd: "24.000000" },
    { targetUsd: "25.000000" },
  ])
    expect(() =>
      proratedAllowanceIncrease({ ...period, effectiveAtMs: 4000, ...change }),
    ).toThrow();
});
