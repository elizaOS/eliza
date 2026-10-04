import { expect, test } from "bun:test";
import { createOrganizationUpgradeReadBudget as budget } from "./organization-upgrade-read-budget";

test("successive reads share one deadline and disable unowned read retries", () => {
  let now = 100;
  const b = budget(20_000, () => now);
  expect(b.requestOptions()).toEqual({
    apiVersion: "2024-11-20.acacia",
    timeout: 10_000,
    maxNetworkRetries: 0,
  });
  now += 15_000;
  expect(b.requestOptions().timeout).toBe(5_000);
  now += 5_000;
  expect(() => b.requestOptions()).toThrow();
});
test("invalid budgets cannot create an unbounded attempt", () => {
  for (const ms of [0, -1, 20_001, NaN, Infinity, 1.5]) expect(() => budget(ms)).toThrow();
});
test("non-finite and backward monotonic clocks reject new reads", () => {
  let now = 100;
  const b = budget(100, () => now);
  now = 99;
  expect(() => b.remainingMs()).toThrow();
  now = NaN;
  expect(() => b.remainingMs()).toThrow();
});
