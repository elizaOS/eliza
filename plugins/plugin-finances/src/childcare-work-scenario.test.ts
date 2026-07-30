/**
 * Exercises the childcare/work engine with deterministic hourly-worker and
 * executive household options, missing-input boundaries, and malformed ranges.
 */

import { describe, expect, it } from "vitest";
import { runChildcareWorkScenarioJson } from "./actions/finances.ts";
import {
  CHILDCARE_WORK_FORMULA_SET_ID,
  CHILDCARE_WORK_SCENARIO_VERSION,
  type ChildcareWorkOption,
  type ChildcareWorkScenarioInput,
  decodeChildcareWorkScenarioInput,
  evaluateChildcareWorkScenario,
  type FinancialSource,
  type MoneyAssumption,
} from "./childcare-work-scenario.ts";

const SOURCE: FinancialSource = {
  sourceId: "worksheet-2026-07",
  label: "Household worksheet",
  observedAt: "2026-07-26T12:00:00.000Z",
};

function known(minUsd: number, maxUsd = minUsd): MoneyAssumption {
  return {
    status: "known",
    annualUsd: { minUsd, maxUsd },
    source: SOURCE,
  };
}

const NA: MoneyAssumption = {
  status: "not_applicable",
  reason: "This option does not include the category.",
};

function option(
  overrides: Partial<ChildcareWorkOption> = {},
): ChildcareWorkOption {
  return {
    optionId: "hourly",
    label: "Hourly role with rotating shifts",
    grossCashCompensation: known(42_000, 48_000),
    variableCompensation: known(0, 2_000),
    equityCompensation: NA,
    taxesAndPayroll: known(8_000, 12_000),
    employeeBenefitsValue: known(4_000, 7_000),
    employerRetirementValue: known(1_200, 2_400),
    healthInsuranceCost: known(3_600, 4_800),
    commuteCost: known(2_400, 3_600),
    workExpense: known(600, 1_200),
    householdSupportCost: known(0, 1_500),
    otherHouseholdIncomeDelta: known(-4_000, -2_000),
    childcare: [
      {
        childEntityId: "child-a",
        label: "Younger child",
        regularCareCost: known(12_000, 15_000),
        backupCareCost: known(1_500, 4_000),
        uncoveredHoursPerMonth: {
          status: "known",
          range: { min: 0, max: 10 },
          source: SOURCE,
        },
      },
      {
        childEntityId: "child-b",
        label: "Older child",
        regularCareCost: known(3_000, 5_000),
        backupCareCost: known(500, 1_500),
        uncoveredHoursPerMonth: {
          status: "known",
          range: { min: 0, max: 4 },
          source: SOURCE,
        },
      },
    ],
    scheduleReliability: {
      status: "known",
      range: { min: 0.72, max: 0.88 },
      source: SOURCE,
    },
    reentryEffect: {
      status: "known",
      horizonYears: 5,
      futureHouseholdEarningsDeltaUsd: {
        minUsd: 8_000,
        maxUsd: 35_000,
      },
      source: SOURCE,
      rationale:
        "Maintaining current credentials and recent experience may improve later earnings.",
    },
    ...overrides,
  };
}

function scenario(
  options: readonly ChildcareWorkOption[],
): ChildcareWorkScenarioInput {
  return {
    schemaVersion: CHILDCARE_WORK_SCENARIO_VERSION,
    scenarioId: "scenario-1",
    householdId: "household-1",
    asOf: "2026-07-26T12:00:00.000Z",
    currency: "USD",
    options,
  };
}

describe("evaluateChildcareWorkScenario", () => {
  it("models an hourly household option without assigning care cost against one parent's wage", () => {
    const stayHome = option({
      optionId: "current",
      label: "Current household arrangement",
      grossCashCompensation: NA,
      variableCompensation: NA,
      taxesAndPayroll: NA,
      employeeBenefitsValue: NA,
      employerRetirementValue: NA,
      healthInsuranceCost: NA,
      commuteCost: NA,
      workExpense: NA,
      householdSupportCost: NA,
      otherHouseholdIncomeDelta: NA,
      childcare: [],
      scheduleReliability: {
        status: "known",
        range: { min: 0.95, max: 1 },
        source: SOURCE,
      },
      reentryEffect: {
        status: "known",
        horizonYears: 5,
        futureHouseholdEarningsDeltaUsd: {
          minUsd: -40_000,
          maxUsd: -5_000,
        },
        source: SOURCE,
        rationale: "A longer employment gap can reduce later earnings.",
      },
    });
    const result = evaluateChildcareWorkScenario(
      scenario([stayHome, option()]),
    );

    expect(result.status).toBe("complete");
    const hourly = result.options[1];
    expect(hourly.annualChildcareCostUsd).toEqual({
      minUsd: 17_000,
      maxUsd: 25_500,
    });
    expect(hourly.annualCashFlowDeltaUsd).toEqual({
      minUsd: -10_600,
      maxUsd: 16_400,
    });
    expect(hourly.annualTotalEconomicDeltaUsd).toEqual({
      minUsd: -5_400,
      maxUsd: 25_800,
    });
    expect(hourly.sensitivity[0]?.path).toBe("grossCashCompensation");
    expect(result.comparisons).toEqual([
      {
        leftOptionId: "current",
        rightOptionId: "hourly",
        status: "complete",
        annualEconomicDifferenceUsd: {
          minUsd: -5_400,
          maxUsd: 25_800,
        },
        interpretation: "ranges_overlap",
      },
    ]);
    expect(result.guardrails.join(" ")).toContain("which adult should work");
  });

  it("keeps executive equity, retirement, care by child, and household income effects visible", () => {
    const current = option({
      optionId: "current-role",
      label: "Current executive role",
      grossCashCompensation: known(210_000),
      variableCompensation: known(20_000, 60_000),
      equityCompensation: known(0, 90_000),
      taxesAndPayroll: known(75_000, 125_000),
      employeeBenefitsValue: known(15_000),
      employerRetirementValue: known(10_000),
      healthInsuranceCost: known(6_000),
      commuteCost: known(2_000),
      workExpense: known(3_000),
      householdSupportCost: known(18_000),
      otherHouseholdIncomeDelta: known(-15_000, -5_000),
      childcare: [
        {
          childEntityId: "child-a",
          label: "Child A",
          regularCareCost: known(28_000),
          backupCareCost: known(4_000, 12_000),
          uncoveredHoursPerMonth: {
            status: "known",
            range: { min: 0, max: 6 },
            source: SOURCE,
          },
        },
      ],
    });
    const reduced = option({
      optionId: "reduced-role",
      label: "Reduced-hours role",
      grossCashCompensation: known(140_000),
      variableCompensation: known(0, 20_000),
      equityCompensation: known(0, 30_000),
      taxesAndPayroll: known(40_000, 70_000),
      employeeBenefitsValue: known(12_000),
      employerRetirementValue: known(7_000),
      healthInsuranceCost: known(6_000),
      commuteCost: known(1_000),
      workExpense: known(1_500),
      householdSupportCost: known(8_000),
      otherHouseholdIncomeDelta: known(0, 5_000),
      childcare: [
        {
          childEntityId: "child-a",
          label: "Child A",
          regularCareCost: known(15_000),
          backupCareCost: known(1_000, 4_000),
          uncoveredHoursPerMonth: {
            status: "known",
            range: { min: 0, max: 2 },
            source: SOURCE,
          },
        },
      ],
    });

    const result = evaluateChildcareWorkScenario(scenario([current, reduced]));

    expect(result.status).toBe("complete");
    expect(result.options[0]?.sensitivity.map((item) => item.path)).toContain(
      "equityCompensation",
    );
    expect(result.options[0]?.reentryEffect).toEqual(current.reentryEffect);
    expect(result.comparisons[0]?.annualEconomicDifferenceUsd).not.toBeNull();
    expect(result.comparisons[0]?.interpretation).toBe("ranges_overlap");
    expect(result.comparableFormulaSetId).toBe(CHILDCARE_WORK_FORMULA_SET_ID);
    expect(result.inputRevisionIds).toHaveLength(2);
    expect(new Set(result.inputRevisionIds).size).toBe(2);
    expect(
      result.inputRevisionIds.every((revision) =>
        /^sha256:[0-9a-f]{64}$/u.test(revision),
      ),
    ).toBe(true);
    expect(
      evaluateChildcareWorkScenario(scenario([current, reduced]))
        .inputRevisionIds,
    ).toEqual(result.inputRevisionIds);
  });

  it("blocks numeric totals when insurance, retirement, reliability, or per-child care is missing", () => {
    const incomplete = option({
      employerRetirementValue: {
        status: "missing",
        reason: "Offer summary does not describe the match.",
      },
      healthInsuranceCost: {
        status: "missing",
        reason: "Need the employee premium and current plan comparison.",
      },
      scheduleReliability: {
        status: "missing",
        reason: "Shift posting and cancellation history is not available.",
      },
      childcare: [
        {
          childEntityId: "child-a",
          label: "Child A",
          regularCareCost: {
            status: "missing",
            reason: "Provider quote pending.",
          },
          backupCareCost: known(1_000),
          uncoveredHoursPerMonth: {
            status: "missing",
            reason: "Coverage schedule has not been reconciled.",
          },
        },
      ],
    });
    const comparison = option({
      optionId: "comparison",
      label: "Comparison",
    });

    const result = evaluateChildcareWorkScenario(
      scenario([incomplete, comparison]),
    );

    expect(result.status).toBe("incomplete");
    expect(result.options[0]?.annualCashFlowDeltaUsd).toBeNull();
    expect(result.options[0]?.annualTotalEconomicDeltaUsd).toBeNull();
    expect(result.missingAssumptions.map((item) => item.path)).toEqual([
      "employerRetirementValue",
      "healthInsuranceCost",
      "scheduleReliability",
      "childcare.child-a.regularCareCost",
      "childcare.child-a.uncoveredHoursPerMonth",
    ]);
    expect(result.comparisons[0]?.interpretation).toBe("incomplete");
  });

  it("fails fast on malformed ranges, duplicates, and unsupported schema inputs", () => {
    expect(() =>
      evaluateChildcareWorkScenario(
        scenario([
          option({
            grossCashCompensation: known(20_000, 10_000),
          }),
          option({ optionId: "comparison" }),
        ]),
      ),
    ).toThrow(/minUsd <= maxUsd/);

    expect(() =>
      evaluateChildcareWorkScenario(
        scenario([option(), option({ label: "Duplicate id" })]),
      ),
    ).toThrow(/duplicate option id/);

    expect(() =>
      evaluateChildcareWorkScenario({
        ...scenario([option(), option({ optionId: "comparison" })]),
        schemaVersion: "childcare-work-scenario.v0" as never,
      }),
    ).toThrow(/unsupported childcare\/work schema version/);
  });

  it("decodes the full JSON contract and exposes it through the owner-finance handler seam", () => {
    const input = scenario([
      option({
        optionId: "current",
        label: "Current arrangement",
      }),
      option({
        optionId: "new-role",
        label: "New role",
      }),
    ]);
    const decoded = decodeChildcareWorkScenarioInput(
      JSON.parse(JSON.stringify(input)),
    );
    expect(decoded).toEqual(input);

    const result = runChildcareWorkScenarioJson(JSON.stringify(input));
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/decision support/);
    expect(result.data?.scenario).toMatchObject({
      schemaVersion: CHILDCARE_WORK_SCENARIO_VERSION,
      status: "complete",
    });
  });

  it("returns explicit invalid JSON and preserves structurally missing inputs", () => {
    const invalidJson = runChildcareWorkScenarioJson("{not-json");
    expect(invalidJson.success).toBe(false);
    expect(invalidJson.data).toEqual({
      error: "INVALID_CHILDCARE_WORK_SCENARIO_JSON",
    });

    const incomplete = scenario([
      option({
        optionId: "missing-offer",
        label: "Offer with unknown insurance",
        healthInsuranceCost: {
          status: "missing",
          reason: "Premium comparison is pending.",
        },
      }),
      option({
        optionId: "comparison",
        label: "Comparison",
      }),
    ]);
    const result = runChildcareWorkScenarioJson(JSON.stringify(incomplete));
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/1 material assumption/);
    expect(result.data?.scenario).toMatchObject({
      status: "incomplete",
      missingAssumptions: [
        {
          optionId: "missing-offer",
          path: "healthInsuranceCost",
        },
      ],
    });
  });
});
