/**
 * Enforces authoring-quality invariants that the structural scenario schema
 * cannot express, while pinning the existing migration debt by scenario ID.
 */

import type {
  ScenarioDefinition,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";

export type ScenarioQualityIssueCode =
  | "zero-judge-threshold"
  | "duplicate-action-alternative"
  | "duplicate-turn-name"
  | "unconditional-custom-predicate"
  | "simulated-evidence-claim";

export type ScenarioQualityIssue = {
  code: ScenarioQualityIssueCode;
  detail: string;
};

/**
 * Exact ratchet for known corpus debt. Remove an ID from a set in the same
 * change that repairs it; tests require these sets to match the live debt.
 */
export const LEGACY_SCENARIO_QUALITY_DEBT: Readonly<
  Record<ScenarioQualityIssueCode, ReadonlySet<string>>
> = {
  "zero-judge-threshold": new Set(),
  "simulated-evidence-claim": new Set(),
  "duplicate-turn-name": new Set(),
  "duplicate-action-alternative": new Set(),
  "unconditional-custom-predicate": new Set(),
};

function isUnconditionalPassingPredicate(
  predicate: (...args: never[]) => unknown,
): boolean {
  const source = Function.prototype.toString
    .call(predicate)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  return (
    /=>\s*(?:undefined|void\s+0)\s*;?$/.test(source) ||
    /=>\s*\{\s*(?:return\s*;?|return\s+(?:undefined|void\s+0)\s*;?)?\s*\}$/.test(
      source,
    )
  );
}

function normalizedDuplicates(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim().toUpperCase());
  return [
    ...new Set(
      normalized.filter(
        (value, index) =>
          value.length > 0 && normalized.indexOf(value) !== index,
      ),
    ),
  ];
}

function actionAlternatives(
  check: ScenarioFinalCheck,
): readonly string[] | undefined {
  if (!("actionName" in check) || !Array.isArray(check.actionName)) {
    return undefined;
  }
  return check.actionName;
}

function hasEvidenceClaim(scenario: ScenarioDefinition): boolean {
  const claimSurface = [
    scenario.id,
    scenario.title,
    scenario.description ?? "",
    scenario.domain,
    ...(scenario.tags ?? []),
  ].join(" ");
  return /\bcertif(?:y|ies|ied|ication)\b|\bprovider[- ](?:e2e|qualified|evidence)\b/i.test(
    claimSurface,
  );
}

export function inspectScenarioQuality(
  scenario: ScenarioDefinition,
): ScenarioQualityIssue[] {
  const issues: ScenarioQualityIssue[] = [];

  for (const [index, turn] of scenario.turns.entries()) {
    if (turn.responseJudge?.minimumScore === 0) {
      issues.push({
        code: "zero-judge-threshold",
        detail: `turn ${index + 1} (${turn.name}) has responseJudge.minimumScore 0`,
      });
    }
    const duplicateActions = normalizedDuplicates(turn.expectedActions ?? []);
    if (duplicateActions.length > 0) {
      issues.push({
        code: "duplicate-action-alternative",
        detail: `turn ${index + 1} (${turn.name}) repeats expectedActions: ${duplicateActions.join(", ")}`,
      });
    }
  }

  const normalizedTurnNames = scenario.turns.map((turn) =>
    (turn.name ?? "").trim().toLocaleLowerCase("en-US"),
  );
  const duplicateTurnNames = [
    ...new Set(
      normalizedTurnNames.filter(
        (name, index) =>
          name.length > 0 && normalizedTurnNames.indexOf(name) !== index,
      ),
    ),
  ];
  if (duplicateTurnNames.length > 0) {
    issues.push({
      code: "duplicate-turn-name",
      detail: `repeats turn names: ${duplicateTurnNames.join(", ")}`,
    });
  }

  for (const [index, check] of (scenario.finalChecks ?? []).entries()) {
    if (check.type === "judgeRubric" && check.minimumScore === 0) {
      issues.push({
        code: "zero-judge-threshold",
        detail: `finalChecks[${index}] (${check.name}) has minimumScore 0`,
      });
    }
    const duplicateActions = normalizedDuplicates(
      actionAlternatives(check) ?? [],
    );
    if (duplicateActions.length > 0) {
      issues.push({
        code: "duplicate-action-alternative",
        detail: `finalChecks[${index}] (${check.type}) repeats actionName alternatives: ${duplicateActions.join(", ")}`,
      });
    }
    if (
      check.type === "custom" &&
      isUnconditionalPassingPredicate(
        check.predicate as (...args: never[]) => unknown,
      )
    ) {
      issues.push({
        code: "unconditional-custom-predicate",
        detail: `finalChecks[${index}] (${check.name}) always passes`,
      });
    }
  }

  if (
    (scenario.executionProfile ?? "simulated") === "simulated" &&
    hasEvidenceClaim(scenario)
  ) {
    issues.push({
      code: "simulated-evidence-claim",
      detail:
        "simulated scenario uses certification or provider-evidence language",
    });
  }

  return issues;
}

export function assertScenarioQuality(
  scenario: ScenarioDefinition,
  file: string,
): void {
  const newIssues = inspectScenarioQuality(scenario).filter(
    (issue) => !LEGACY_SCENARIO_QUALITY_DEBT[issue.code].has(scenario.id),
  );
  if (newIssues.length === 0) return;

  throw new Error(
    `[scenario-quality] ${file} (${scenario.id}):\n${newIssues
      .map((issue) => `- ${issue.code}: ${issue.detail}`)
      .join("\n")}`,
  );
}
