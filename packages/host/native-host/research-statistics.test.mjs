import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapMeanInterval,
  wilson95Interval,
} from "./research-statistics.mjs";

const policy = {
  resamples: 2000,
  seed: 0x51c0ffee,
  lowerQuantile: 0.025,
  upperQuantile: 0.975,
  maxDraws: 20000000,
};
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
test("Wilson intervals preserve empty denominators and binomial boundary cases", () => {
  assert.equal(wilson95Interval(0, 0), null);
  near(wilson95Interval(0, 10).upper, 0.2775327998628892);
  near(wilson95Interval(10, 10).lower, 0.7224672001371107);
  near(wilson95Interval(1, 2).lower, 0.09453120573423074);
  near(wilson95Interval(1, 2).upper, 0.9054687942657693);
});
test("Wilson rejects invalid counts and preserves complement symmetry", () => {
  for (const pair of [
    [-1, 2],
    [3, 2],
    [0.5, 2],
    [0, NaN],
    [1, Infinity],
  ])
    assert.throws(() => wilson95Interval(...pair), RangeError);
  for (let n = 0; n <= 30; n++) {
    const a = wilson95Interval(n, 30),
      b = wilson95Interval(30 - n, 30);
    near(a.lower, 1 - b.upper);
    near(a.upper, 1 - b.lower);
  }
});
test("bootstrap handles insufficient, constant and two-point samples without mutation", () => {
  assert.equal(bootstrapMeanInterval([], policy), null);
  assert.equal(bootstrapMeanInterval([7], policy), null);
  assert.deepEqual(bootstrapMeanInterval([7, 7, 7], policy), {
    lower: 7,
    upper: 7,
  });
  const values = Object.freeze([-1, 1]);
  assert.deepEqual(bootstrapMeanInterval(values, policy), {
    lower: -1,
    upper: 1,
  });
  assert.deepEqual(values, [-1, 1]);
});
test("bootstrap is deterministic and respects translation and scaling", () => {
  const values = [-30, -5, 0, 25, 80];
  const result = bootstrapMeanInterval(values, policy);
  assert.deepEqual(bootstrapMeanInterval(values, policy), result);
  const shifted = bootstrapMeanInterval(
    values.map((x) => x + 10),
    policy,
  );
  near(shifted.lower, result.lower + 10);
  near(shifted.upper, result.upper + 10);
  const scaled = bootstrapMeanInterval(
    values.map((x) => x * 2),
    policy,
  );
  near(scaled.lower, result.lower * 2);
  near(scaled.upper, result.upper * 2);
});
test("bootstrap refuses invalid data, policy, excessive work and arithmetic overflow", () => {
  for (const values of [[NaN, 1], [Infinity, 1], Array(2)])
    assert.throws(() => bootstrapMeanInterval(values, policy), RangeError);
  for (const change of [
    { resamples: 0 },
    { seed: -1 },
    { seed: 2 ** 32 },
    { lowerQuantile: 0 },
    { upperQuantile: 1 },
    { lowerQuantile: 0.98 },
    { maxDraws: 3999 },
  ]) {
    assert.throws(
      () => bootstrapMeanInterval([1, 2], { ...policy, ...change }),
      RangeError,
    );
  }
  assert.throws(
    () => bootstrapMeanInterval([Number.MAX_VALUE, Number.MAX_VALUE], policy),
    RangeError,
  );
});
