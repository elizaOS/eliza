import { afterEach, describe, expect, test } from "bun:test";
import { validateEnvironment } from "@/lib/config/env-validator";

const originalCotBudget = process.env.ANTHROPIC_COT_BUDGET;
const originalCotBudgetMax = process.env.ANTHROPIC_COT_BUDGET_MAX;

afterEach(() => {
  if (originalCotBudget === undefined) {
    delete process.env.ANTHROPIC_COT_BUDGET;
  } else {
    process.env.ANTHROPIC_COT_BUDGET = originalCotBudget;
  }

  if (originalCotBudgetMax === undefined) {
    delete process.env.ANTHROPIC_COT_BUDGET_MAX;
  } else {
    process.env.ANTHROPIC_COT_BUDGET_MAX = originalCotBudgetMax;
  }
});

describe("validateEnvironment", () => {
  test("treats invalid ANTHROPIC_COT_BUDGET as an error instead of a warning", () => {
    process.env.ANTHROPIC_COT_BUDGET = "abc";
    delete process.env.ANTHROPIC_COT_BUDGET_MAX;

    const result = validateEnvironment();

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: "ANTHROPIC_COT_BUDGET" })]),
    );
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: "ANTHROPIC_COT_BUDGET" })]),
    );
  });

  test("treats invalid ANTHROPIC_COT_BUDGET_MAX as an error instead of a warning", () => {
    delete process.env.ANTHROPIC_COT_BUDGET;
    process.env.ANTHROPIC_COT_BUDGET_MAX = "NaN";

    const result = validateEnvironment();

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: "ANTHROPIC_COT_BUDGET_MAX" })]),
    );
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: "ANTHROPIC_COT_BUDGET_MAX" })]),
    );
  });
});
