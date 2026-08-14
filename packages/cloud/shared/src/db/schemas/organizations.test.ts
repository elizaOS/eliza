// Exercises cloud DB organizations behavior with deterministic repository fixtures.
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * #8427 — a brand-new organization must start at $0, not the old $100 give-away
 * footgun. The signup grant (steward-sync) adds the small welcome bonus
 * explicitly; the column itself defaults to zero, and a CHECK keeps the balance
 * non-negative.
 */
describe("#8427 organizations zero-balance default", () => {
  const config = getTableConfig(organizations);

  test("credit_balance defaults to 0, not a give-away", () => {
    const col = config.columns.find((c) => c.name === "credit_balance");
    expect(col).toBeDefined();
    expect(col?.default).toBe("0.000000");
    expect(Number(col?.default)).toBe(0);
  });

  test("a non-negative credit_balance CHECK constraint is present", () => {
    const checkNames = config.checks.map((c) => c.name);
    expect(checkNames).toContain("credit_balance_non_negative");
  });
});
