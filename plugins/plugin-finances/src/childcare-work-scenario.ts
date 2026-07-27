/**
 * Deterministic household-wide comparison engine for childcare and paid-work
 * options. It keeps every economically material input explicit, separates
 * current cash flow from benefits and longer-horizon re-entry effects, and
 * returns ranges and sensitivity rather than a prescriptive verdict. Callers
 * must provide a known value or an explicit not-applicable reason; missing
 * values make an option incomplete instead of silently becoming zero.
 */

import { ElizaError } from "@elizaos/core";

export const CHILDCARE_WORK_SCENARIO_VERSION =
  "childcare-work-scenario.v1" as const;

export interface UsdRange {
  readonly minUsd: number;
  readonly maxUsd: number;
}

export interface FinancialSource {
  readonly sourceId: string;
  readonly label: string;
  readonly observedAt: string;
}

export type MoneyAssumption =
  | {
      readonly status: "known";
      readonly annualUsd: UsdRange;
      readonly source: FinancialSource;
    }
  | {
      readonly status: "not_applicable";
      readonly reason: string;
    }
  | {
      readonly status: "missing";
      readonly reason: string;
    };

export type RatioAssumption =
  | {
      readonly status: "known";
      readonly range: {
        readonly min: number;
        readonly max: number;
      };
      readonly source: FinancialSource;
    }
  | {
      readonly status: "missing";
      readonly reason: string;
    };

export type ReentryAssumption =
  | {
      readonly status: "known";
      readonly horizonYears: number;
      /**
       * Positive values mean the option improves expected future household
       * earnings; negative values mean it reduces them.
       */
      readonly futureHouseholdEarningsDeltaUsd: UsdRange;
      readonly source: FinancialSource;
      readonly rationale: string;
    }
  | {
      readonly status: "not_applicable";
      readonly reason: string;
    }
  | {
      readonly status: "missing";
      readonly reason: string;
    };

export interface ChildcarePlan {
  readonly childEntityId: string;
  readonly label: string;
  readonly regularCareCost: MoneyAssumption;
  readonly backupCareCost: MoneyAssumption;
  readonly uncoveredHoursPerMonth: RatioAssumption;
}

export interface ChildcareWorkOption {
  readonly optionId: string;
  readonly label: string;
  readonly grossCashCompensation: MoneyAssumption;
  readonly variableCompensation: MoneyAssumption;
  readonly equityCompensation: MoneyAssumption;
  readonly taxesAndPayroll: MoneyAssumption;
  readonly employeeBenefitsValue: MoneyAssumption;
  readonly employerRetirementValue: MoneyAssumption;
  /**
   * An added household cost. Savings from an employer plan belong in
   * `employeeBenefitsValue`, which keeps all cost ranges non-negative.
   */
  readonly healthInsuranceCost: MoneyAssumption;
  readonly commuteCost: MoneyAssumption;
  readonly workExpense: MoneyAssumption;
  readonly householdSupportCost: MoneyAssumption;
  /**
   * Captures changes to another adult's earnings, for example reduced shifts
   * caused by pickup coverage. A positive value is an inflow and a negative
   * value is an outflow.
   */
  readonly otherHouseholdIncomeDelta: MoneyAssumption;
  readonly childcare: readonly ChildcarePlan[];
  readonly scheduleReliability: RatioAssumption;
  readonly reentryEffect: ReentryAssumption;
  readonly notes?: readonly string[];
}

export interface ChildcareWorkScenarioInput {
  readonly schemaVersion: typeof CHILDCARE_WORK_SCENARIO_VERSION;
  readonly scenarioId: string;
  readonly householdId: string;
  readonly asOf: string;
  readonly currency: "USD";
  readonly options: readonly ChildcareWorkOption[];
}

export interface MissingScenarioAssumption {
  readonly optionId: string;
  readonly path: string;
  readonly reason: string;
}

export interface SensitivityDriver {
  readonly path: string;
  readonly effect: "inflow" | "outflow";
  readonly annualUsd: UsdRange;
  readonly uncertaintyWidthUsd: number;
}

export interface EvaluatedChildcareWorkOption {
  readonly optionId: string;
  readonly label: string;
  readonly status: "complete" | "incomplete";
  readonly annualCashFlowDeltaUsd: UsdRange | null;
  readonly monthlyCashFlowDeltaUsd: UsdRange | null;
  readonly annualTotalEconomicDeltaUsd: UsdRange | null;
  readonly monthlyTotalEconomicDeltaUsd: UsdRange | null;
  readonly annualChildcareCostUsd: UsdRange | null;
  readonly childcareCostByChild: readonly {
    readonly childEntityId: string;
    readonly label: string;
    readonly annualUsd: UsdRange | null;
  }[];
  readonly scheduleReliability: RatioAssumption;
  readonly reentryEffect: ReentryAssumption;
  readonly missingAssumptions: readonly MissingScenarioAssumption[];
  readonly sensitivity: readonly SensitivityDriver[];
  readonly notes: readonly string[];
}

export interface ChildcareWorkComparison {
  readonly leftOptionId: string;
  readonly rightOptionId: string;
  readonly status: "complete" | "incomplete";
  /**
   * Right minus left. A fully positive range means the right option has a
   * larger modeled annual economic contribution; overlapping zero means the
   * current assumptions do not distinguish them.
   */
  readonly annualEconomicDifferenceUsd: UsdRange | null;
  readonly interpretation:
    | "right_higher"
    | "left_higher"
    | "ranges_overlap"
    | "incomplete";
}

export interface ChildcareWorkScenarioResult {
  readonly schemaVersion: typeof CHILDCARE_WORK_SCENARIO_VERSION;
  readonly scenarioId: string;
  readonly householdId: string;
  readonly asOf: string;
  readonly status: "complete" | "incomplete";
  readonly options: readonly EvaluatedChildcareWorkOption[];
  readonly comparisons: readonly ChildcareWorkComparison[];
  readonly missingAssumptions: readonly MissingScenarioAssumption[];
  readonly guardrails: readonly string[];
}

interface RangeContribution {
  readonly path: string;
  readonly effect: "inflow" | "outflow";
  readonly range: UsdRange;
}

type OptionMoneyField =
  | "grossCashCompensation"
  | "variableCompensation"
  | "equityCompensation"
  | "taxesAndPayroll"
  | "employeeBenefitsValue"
  | "employerRetirementValue"
  | "healthInsuranceCost"
  | "commuteCost"
  | "workExpense"
  | "householdSupportCost";

const OPTION_MONEY_FIELDS = [
  ["grossCashCompensation", "inflow"],
  ["variableCompensation", "inflow"],
  ["equityCompensation", "inflow"],
  ["taxesAndPayroll", "outflow"],
  ["employeeBenefitsValue", "inflow"],
  ["employerRetirementValue", "inflow"],
  ["healthInsuranceCost", "outflow"],
  ["commuteCost", "outflow"],
  ["workExpense", "outflow"],
  ["householdSupportCost", "outflow"],
] as const satisfies readonly [OptionMoneyField, "inflow" | "outflow"][];

function invalidScenario(message: string, path: string): ElizaError {
  return new ElizaError(message, {
    code: "FINANCE_CHILDCARE_SCENARIO_INVALID",
    context: { path },
    severity: "ephemeral",
  });
}

function assertFiniteRange(range: UsdRange, path: string): void {
  if (
    !Number.isFinite(range.minUsd) ||
    !Number.isFinite(range.maxUsd) ||
    range.minUsd > range.maxUsd
  ) {
    throw invalidScenario(
      `${path} must contain finite minUsd <= maxUsd values`,
      path,
    );
  }
}

function assertNonNegativeRange(range: UsdRange, path: string): void {
  assertFiniteRange(range, path);
  if (range.minUsd < 0) {
    throw invalidScenario(`${path} cannot be negative`, path);
  }
}

function assertRatio(
  assumption: RatioAssumption,
  path: string,
  maximum: number,
): void {
  if (assumption.status !== "known") {
    if (assumption.reason.trim().length === 0) {
      throw invalidScenario(`${path}.reason cannot be empty`, `${path}.reason`);
    }
    return;
  }
  const { min, max } = assumption.range;
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < 0 ||
    min > max ||
    max > maximum
  ) {
    throw invalidScenario(
      `${path}.range must contain finite 0 <= min <= max <= ${maximum}`,
      `${path}.range`,
    );
  }
  assertSource(assumption.source, `${path}.source`);
}

function assertSource(source: FinancialSource, path: string): void {
  if (
    source.sourceId.trim().length === 0 ||
    source.label.trim().length === 0 ||
    !Number.isFinite(Date.parse(source.observedAt))
  ) {
    throw invalidScenario(`${path} must identify a dated source`, path);
  }
}

function validateMoneyAssumption(
  assumption: MoneyAssumption,
  path: string,
  allowSigned = false,
): void {
  if (assumption.status === "known") {
    if (allowSigned) {
      assertFiniteRange(assumption.annualUsd, `${path}.annualUsd`);
    } else {
      assertNonNegativeRange(assumption.annualUsd, `${path}.annualUsd`);
    }
    assertSource(assumption.source, `${path}.source`);
    return;
  }
  if (assumption.reason.trim().length === 0) {
    throw invalidScenario(`${path}.reason cannot be empty`, `${path}.reason`);
  }
}

function validateInput(input: ChildcareWorkScenarioInput): void {
  if (input.schemaVersion !== CHILDCARE_WORK_SCENARIO_VERSION) {
    throw invalidScenario(
      `unsupported childcare/work schema version ${input.schemaVersion}`,
      "schemaVersion",
    );
  }
  if (
    input.scenarioId.trim().length === 0 ||
    input.householdId.trim().length === 0 ||
    !Number.isFinite(Date.parse(input.asOf))
  ) {
    throw invalidScenario(
      "scenarioId, householdId, and a valid asOf timestamp are required",
      "scenario",
    );
  }
  if (input.currency !== "USD") {
    throw invalidScenario(
      "childcare/work scenario v1 supports USD only",
      "currency",
    );
  }
  if (input.options.length < 2) {
    throw invalidScenario(
      "at least two options are required for comparison",
      "options",
    );
  }

  const optionIds = new Set<string>();
  for (const option of input.options) {
    if (
      option.optionId.trim().length === 0 ||
      option.label.trim().length === 0
    ) {
      throw invalidScenario("every option requires an id and label", "options");
    }
    if (optionIds.has(option.optionId)) {
      throw invalidScenario(
        `duplicate option id ${option.optionId}`,
        `options.${option.optionId}`,
      );
    }
    optionIds.add(option.optionId);

    for (const [field] of OPTION_MONEY_FIELDS) {
      validateMoneyAssumption(option[field], `${option.optionId}.${field}`);
    }
    validateMoneyAssumption(
      option.otherHouseholdIncomeDelta,
      `${option.optionId}.otherHouseholdIncomeDelta`,
      true,
    );
    assertRatio(
      option.scheduleReliability,
      `${option.optionId}.scheduleReliability`,
      1,
    );

    const childIds = new Set<string>();
    for (const care of option.childcare) {
      if (
        care.childEntityId.trim().length === 0 ||
        care.label.trim().length === 0
      ) {
        throw invalidScenario(
          `${option.optionId}.childcare requires childEntityId and label`,
          `${option.optionId}.childcare`,
        );
      }
      if (childIds.has(care.childEntityId)) {
        throw invalidScenario(
          `${option.optionId}.childcare repeats child ${care.childEntityId}`,
          `${option.optionId}.childcare.${care.childEntityId}`,
        );
      }
      childIds.add(care.childEntityId);
      validateMoneyAssumption(
        care.regularCareCost,
        `${option.optionId}.childcare.${care.childEntityId}.regularCareCost`,
      );
      validateMoneyAssumption(
        care.backupCareCost,
        `${option.optionId}.childcare.${care.childEntityId}.backupCareCost`,
      );
      assertRatio(
        care.uncoveredHoursPerMonth,
        `${option.optionId}.childcare.${care.childEntityId}.uncoveredHoursPerMonth`,
        Number.MAX_SAFE_INTEGER,
      );
    }

    const reentry = option.reentryEffect;
    if (reentry.status === "known") {
      if (
        !Number.isSafeInteger(reentry.horizonYears) ||
        reentry.horizonYears < 1 ||
        reentry.horizonYears > 50 ||
        reentry.rationale.trim().length === 0
      ) {
        throw invalidScenario(
          `${option.optionId}.reentryEffect requires a 1-50 year horizon and rationale`,
          `${option.optionId}.reentryEffect`,
        );
      }
      assertFiniteRange(
        reentry.futureHouseholdEarningsDeltaUsd,
        `${option.optionId}.reentryEffect.futureHouseholdEarningsDeltaUsd`,
      );
      assertSource(reentry.source, `${option.optionId}.reentryEffect.source`);
    } else if (reentry.reason.trim().length === 0) {
      throw invalidScenario(
        `${option.optionId}.reentryEffect.reason cannot be empty`,
        `${option.optionId}.reentryEffect.reason`,
      );
    }
  }
}

function missingForMoney(
  optionId: string,
  path: string,
  assumption: MoneyAssumption,
): MissingScenarioAssumption | null {
  return assumption.status === "missing"
    ? { optionId, path, reason: assumption.reason }
    : null;
}

function knownRange(assumption: MoneyAssumption): UsdRange {
  if (assumption.status === "known") {
    return assumption.annualUsd;
  }
  if (assumption.status === "not_applicable") {
    return { minUsd: 0, maxUsd: 0 };
  }
  throw invalidScenario(
    "missing assumptions do not have numeric ranges",
    "assumption",
  );
}

function addRanges(left: UsdRange, right: UsdRange): UsdRange {
  return {
    minUsd: left.minUsd + right.minUsd,
    maxUsd: left.maxUsd + right.maxUsd,
  };
}

function subtractRange(left: UsdRange, right: UsdRange): UsdRange {
  return {
    minUsd: left.minUsd - right.maxUsd,
    maxUsd: left.maxUsd - right.minUsd,
  };
}

function scaleRange(range: UsdRange, divisor: number): UsdRange {
  return {
    minUsd: range.minUsd / divisor,
    maxUsd: range.maxUsd / divisor,
  };
}

function sumContributions(
  contributions: readonly RangeContribution[],
): UsdRange {
  let result: UsdRange = { minUsd: 0, maxUsd: 0 };
  for (const contribution of contributions) {
    result =
      contribution.effect === "inflow"
        ? addRanges(result, contribution.range)
        : subtractRange(result, contribution.range);
  }
  return result;
}

function evaluateOption(
  option: ChildcareWorkOption,
): EvaluatedChildcareWorkOption {
  const missing: MissingScenarioAssumption[] = [];
  const contributions: RangeContribution[] = [];

  for (const [field, effect] of OPTION_MONEY_FIELDS) {
    const assumption = option[field];
    const unresolved = missingForMoney(option.optionId, field, assumption);
    if (unresolved) {
      missing.push(unresolved);
    } else {
      contributions.push({
        path: field,
        effect,
        range: knownRange(assumption),
      });
    }
  }

  const otherIncomeMissing = missingForMoney(
    option.optionId,
    "otherHouseholdIncomeDelta",
    option.otherHouseholdIncomeDelta,
  );
  if (otherIncomeMissing) {
    missing.push(otherIncomeMissing);
  } else {
    const range = knownRange(option.otherHouseholdIncomeDelta);
    if (range.minUsd >= 0) {
      contributions.push({
        path: "otherHouseholdIncomeDelta",
        effect: "inflow",
        range,
      });
    } else if (range.maxUsd <= 0) {
      contributions.push({
        path: "otherHouseholdIncomeDelta",
        effect: "outflow",
        range: {
          minUsd: Math.abs(range.maxUsd),
          maxUsd: Math.abs(range.minUsd),
        },
      });
    } else {
      contributions.push({
        path: "otherHouseholdIncomeDelta",
        effect: "inflow",
        range,
      });
    }
  }

  if (option.scheduleReliability.status === "missing") {
    missing.push({
      optionId: option.optionId,
      path: "scheduleReliability",
      reason: option.scheduleReliability.reason,
    });
  }
  if (option.reentryEffect.status === "missing") {
    missing.push({
      optionId: option.optionId,
      path: "reentryEffect",
      reason: option.reentryEffect.reason,
    });
  }

  const childcareCostByChild = option.childcare.map((care) => {
    const regularMissing = missingForMoney(
      option.optionId,
      `childcare.${care.childEntityId}.regularCareCost`,
      care.regularCareCost,
    );
    const backupMissing = missingForMoney(
      option.optionId,
      `childcare.${care.childEntityId}.backupCareCost`,
      care.backupCareCost,
    );
    if (regularMissing) missing.push(regularMissing);
    if (backupMissing) missing.push(backupMissing);
    if (care.uncoveredHoursPerMonth.status === "missing") {
      missing.push({
        optionId: option.optionId,
        path: `childcare.${care.childEntityId}.uncoveredHoursPerMonth`,
        reason: care.uncoveredHoursPerMonth.reason,
      });
    }
    const annualUsd =
      regularMissing || backupMissing
        ? null
        : addRanges(
            knownRange(care.regularCareCost),
            knownRange(care.backupCareCost),
          );
    if (annualUsd) {
      contributions.push({
        path: `childcare.${care.childEntityId}`,
        effect: "outflow",
        range: annualUsd,
      });
    }
    return {
      childEntityId: care.childEntityId,
      label: care.label,
      annualUsd,
    };
  });

  const childcareMissing = childcareCostByChild.some(
    (child) => child.annualUsd === null,
  );
  let annualChildcareCostUsd: UsdRange | null = childcareMissing
    ? null
    : { minUsd: 0, maxUsd: 0 };
  if (annualChildcareCostUsd) {
    for (const child of childcareCostByChild) {
      if (child.annualUsd) {
        annualChildcareCostUsd = addRanges(
          annualChildcareCostUsd,
          child.annualUsd,
        );
      }
    }
  }

  if (missing.length > 0) {
    return {
      optionId: option.optionId,
      label: option.label,
      status: "incomplete",
      annualCashFlowDeltaUsd: null,
      monthlyCashFlowDeltaUsd: null,
      annualTotalEconomicDeltaUsd: null,
      monthlyTotalEconomicDeltaUsd: null,
      annualChildcareCostUsd,
      childcareCostByChild,
      scheduleReliability: option.scheduleReliability,
      reentryEffect: option.reentryEffect,
      missingAssumptions: missing,
      sensitivity: [],
      notes: [...(option.notes ?? [])],
    };
  }

  const cashContributions = contributions.filter(
    (contribution) =>
      contribution.path !== "employeeBenefitsValue" &&
      contribution.path !== "employerRetirementValue" &&
      contribution.path !== "equityCompensation",
  );
  const annualCashFlowDeltaUsd = sumContributions(cashContributions);
  const annualTotalEconomicDeltaUsd = sumContributions(contributions);
  const sensitivity = contributions
    .map<SensitivityDriver>((contribution) => ({
      path: contribution.path,
      effect: contribution.effect,
      annualUsd: contribution.range,
      uncertaintyWidthUsd:
        contribution.range.maxUsd - contribution.range.minUsd,
    }))
    .sort((left, right) => {
      const byWidth = right.uncertaintyWidthUsd - left.uncertaintyWidthUsd;
      return byWidth !== 0 ? byWidth : left.path.localeCompare(right.path);
    });

  return {
    optionId: option.optionId,
    label: option.label,
    status: "complete",
    annualCashFlowDeltaUsd,
    monthlyCashFlowDeltaUsd: scaleRange(annualCashFlowDeltaUsd, 12),
    annualTotalEconomicDeltaUsd,
    monthlyTotalEconomicDeltaUsd: scaleRange(annualTotalEconomicDeltaUsd, 12),
    annualChildcareCostUsd,
    childcareCostByChild,
    scheduleReliability: option.scheduleReliability,
    reentryEffect: option.reentryEffect,
    missingAssumptions: [],
    sensitivity,
    notes: [...(option.notes ?? [])],
  };
}

function compareOptions(
  left: EvaluatedChildcareWorkOption,
  right: EvaluatedChildcareWorkOption,
): ChildcareWorkComparison {
  if (
    left.status !== "complete" ||
    right.status !== "complete" ||
    !left.annualTotalEconomicDeltaUsd ||
    !right.annualTotalEconomicDeltaUsd
  ) {
    return {
      leftOptionId: left.optionId,
      rightOptionId: right.optionId,
      status: "incomplete",
      annualEconomicDifferenceUsd: null,
      interpretation: "incomplete",
    };
  }
  const difference = subtractRange(
    right.annualTotalEconomicDeltaUsd,
    left.annualTotalEconomicDeltaUsd,
  );
  const interpretation =
    difference.minUsd > 0
      ? "right_higher"
      : difference.maxUsd < 0
        ? "left_higher"
        : "ranges_overlap";
  return {
    leftOptionId: left.optionId,
    rightOptionId: right.optionId,
    status: "complete",
    annualEconomicDifferenceUsd: difference,
    interpretation,
  };
}

/**
 * Evaluates options without choosing for the household. The result is safe to
 * render only as decision support: reliability and re-entry effects remain
 * visible alongside the money rather than being hidden inside a single score.
 */
export function evaluateChildcareWorkScenario(
  input: ChildcareWorkScenarioInput,
): ChildcareWorkScenarioResult {
  validateInput(input);
  const options = input.options.map(evaluateOption);
  const comparisons: ChildcareWorkComparison[] = [];
  for (let leftIndex = 0; leftIndex < options.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < options.length;
      rightIndex += 1
    ) {
      comparisons.push(compareOptions(options[leftIndex], options[rightIndex]));
    }
  }
  const missingAssumptions = options.flatMap(
    (option) => option.missingAssumptions,
  );
  return {
    schemaVersion: CHILDCARE_WORK_SCENARIO_VERSION,
    scenarioId: input.scenarioId,
    householdId: input.householdId,
    asOf: input.asOf,
    status: missingAssumptions.length === 0 ? "complete" : "incomplete",
    options,
    comparisons,
    missingAssumptions,
    guardrails: [
      "This is household decision support, not a recommendation about which adult should work.",
      "Current cash flow, non-cash compensation, schedule reliability, and re-entry effects are separate.",
      "Missing assumptions block numeric totals; they are never treated as zero.",
      "Ranges can overlap, and non-financial household values remain outside this model.",
    ],
  };
}

function inputRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidScenario(`${path} must be an object`, path);
  }
  return value as Record<string, unknown>;
}

function inputText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidScenario(`${path} must be a non-empty string`, path);
  }
  return value.trim();
}

function inputArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidScenario(`${path} must be an array`, path);
  }
  return value;
}

function decodeUsdRange(value: unknown, path: string): UsdRange {
  const record = inputRecord(value, path);
  const minUsd = record.minUsd;
  const maxUsd = record.maxUsd;
  if (typeof minUsd !== "number" || typeof maxUsd !== "number") {
    throw invalidScenario(`${path} requires numeric minUsd and maxUsd`, path);
  }
  return { minUsd, maxUsd };
}

function decodeSource(value: unknown, path: string): FinancialSource {
  const record = inputRecord(value, path);
  return {
    sourceId: inputText(record.sourceId, `${path}.sourceId`),
    label: inputText(record.label, `${path}.label`),
    observedAt: inputText(record.observedAt, `${path}.observedAt`),
  };
}

function decodeMoney(value: unknown, path: string): MoneyAssumption {
  const record = inputRecord(value, path);
  if (record.status === "known") {
    return {
      status: "known",
      annualUsd: decodeUsdRange(record.annualUsd, `${path}.annualUsd`),
      source: decodeSource(record.source, `${path}.source`),
    };
  }
  if (record.status === "not_applicable" || record.status === "missing") {
    return {
      status: record.status,
      reason: inputText(record.reason, `${path}.reason`),
    };
  }
  throw invalidScenario(
    `${path}.status must be known, not_applicable, or missing`,
    `${path}.status`,
  );
}

function decodeRatio(value: unknown, path: string): RatioAssumption {
  const record = inputRecord(value, path);
  if (record.status === "known") {
    const range = inputRecord(record.range, `${path}.range`);
    const min = range.min;
    const max = range.max;
    if (typeof min !== "number" || typeof max !== "number") {
      throw invalidScenario(
        `${path}.range requires numeric min and max`,
        `${path}.range`,
      );
    }
    return {
      status: "known",
      range: { min, max },
      source: decodeSource(record.source, `${path}.source`),
    };
  }
  if (record.status === "missing") {
    return {
      status: "missing",
      reason: inputText(record.reason, `${path}.reason`),
    };
  }
  throw invalidScenario(
    `${path}.status must be known or missing`,
    `${path}.status`,
  );
}

function decodeReentry(value: unknown, path: string): ReentryAssumption {
  const record = inputRecord(value, path);
  if (record.status === "known") {
    const horizonYears = record.horizonYears;
    if (typeof horizonYears !== "number") {
      throw invalidScenario(
        `${path}.horizonYears must be numeric`,
        `${path}.horizonYears`,
      );
    }
    return {
      status: "known",
      horizonYears,
      futureHouseholdEarningsDeltaUsd: decodeUsdRange(
        record.futureHouseholdEarningsDeltaUsd,
        `${path}.futureHouseholdEarningsDeltaUsd`,
      ),
      source: decodeSource(record.source, `${path}.source`),
      rationale: inputText(record.rationale, `${path}.rationale`),
    };
  }
  if (record.status === "not_applicable" || record.status === "missing") {
    return {
      status: record.status,
      reason: inputText(record.reason, `${path}.reason`),
    };
  }
  throw invalidScenario(
    `${path}.status must be known, not_applicable, or missing`,
    `${path}.status`,
  );
}

function decodeChildcare(value: unknown, path: string): ChildcarePlan {
  const record = inputRecord(value, path);
  return {
    childEntityId: inputText(record.childEntityId, `${path}.childEntityId`),
    label: inputText(record.label, `${path}.label`),
    regularCareCost: decodeMoney(
      record.regularCareCost,
      `${path}.regularCareCost`,
    ),
    backupCareCost: decodeMoney(
      record.backupCareCost,
      `${path}.backupCareCost`,
    ),
    uncoveredHoursPerMonth: decodeRatio(
      record.uncoveredHoursPerMonth,
      `${path}.uncoveredHoursPerMonth`,
    ),
  };
}

function decodeOption(value: unknown, index: number): ChildcareWorkOption {
  const path = `options[${index}]`;
  const record = inputRecord(value, path);
  const notes =
    record.notes === undefined
      ? undefined
      : inputArray(record.notes, `${path}.notes`).map((note, noteIndex) =>
          inputText(note, `${path}.notes[${noteIndex}]`),
        );
  return {
    optionId: inputText(record.optionId, `${path}.optionId`),
    label: inputText(record.label, `${path}.label`),
    grossCashCompensation: decodeMoney(
      record.grossCashCompensation,
      `${path}.grossCashCompensation`,
    ),
    variableCompensation: decodeMoney(
      record.variableCompensation,
      `${path}.variableCompensation`,
    ),
    equityCompensation: decodeMoney(
      record.equityCompensation,
      `${path}.equityCompensation`,
    ),
    taxesAndPayroll: decodeMoney(
      record.taxesAndPayroll,
      `${path}.taxesAndPayroll`,
    ),
    employeeBenefitsValue: decodeMoney(
      record.employeeBenefitsValue,
      `${path}.employeeBenefitsValue`,
    ),
    employerRetirementValue: decodeMoney(
      record.employerRetirementValue,
      `${path}.employerRetirementValue`,
    ),
    healthInsuranceCost: decodeMoney(
      record.healthInsuranceCost,
      `${path}.healthInsuranceCost`,
    ),
    commuteCost: decodeMoney(record.commuteCost, `${path}.commuteCost`),
    workExpense: decodeMoney(record.workExpense, `${path}.workExpense`),
    householdSupportCost: decodeMoney(
      record.householdSupportCost,
      `${path}.householdSupportCost`,
    ),
    otherHouseholdIncomeDelta: decodeMoney(
      record.otherHouseholdIncomeDelta,
      `${path}.otherHouseholdIncomeDelta`,
    ),
    childcare: inputArray(record.childcare, `${path}.childcare`).map(
      (care, careIndex) =>
        decodeChildcare(care, `${path}.childcare[${careIndex}]`),
    ),
    scheduleReliability: decodeRatio(
      record.scheduleReliability,
      `${path}.scheduleReliability`,
    ),
    reentryEffect: decodeReentry(record.reentryEffect, `${path}.reentryEffect`),
    ...(notes ? { notes } : {}),
  };
}

/**
 * Decodes JSON or planner output at the action boundary before the typed
 * engine sees it. The decoder constructs every nested field and therefore
 * never lets an unchecked cast turn malformed input into a valid scenario.
 */
export function decodeChildcareWorkScenarioInput(
  value: unknown,
): ChildcareWorkScenarioInput {
  const record = inputRecord(value, "scenario");
  if (record.schemaVersion !== CHILDCARE_WORK_SCENARIO_VERSION) {
    throw invalidScenario(
      `unsupported childcare/work schema version ${String(record.schemaVersion)}`,
      "scenario.schemaVersion",
    );
  }
  if (record.currency !== "USD") {
    throw invalidScenario(
      "childcare/work scenario v1 supports USD only",
      "scenario.currency",
    );
  }
  const decoded: ChildcareWorkScenarioInput = {
    schemaVersion: CHILDCARE_WORK_SCENARIO_VERSION,
    scenarioId: inputText(record.scenarioId, "scenario.scenarioId"),
    householdId: inputText(record.householdId, "scenario.householdId"),
    asOf: inputText(record.asOf, "scenario.asOf"),
    currency: "USD",
    options: inputArray(record.options, "scenario.options").map(decodeOption),
  };
  validateInput(decoded);
  return decoded;
}
