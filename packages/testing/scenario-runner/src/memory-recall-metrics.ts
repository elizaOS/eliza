/**
 * Scores observable recall answers without depending on a model or storage implementation.
 * Scenario and live-test adapters supply complete responses plus independently authored
 * expected and forbidden facts; this module returns reviewable quality metrics.
 */

export interface MemoryRecallCase {
  id: string;
  response: string;
  expected: string[];
  forbidden: string[];
}

export type MemoryRecallScore =
  | {
      kind: "invalid";
      reason: string;
    }
  | {
      kind: "scored";
      caseCount: number;
      expectedFactCount: number;
      truePositiveCount: number;
      falseNegativeCount: number;
      falsePositiveCount: number;
      precision: number;
      recall: number;
      falsePositiveRate: number;
      cases: Array<{
        id: string;
        recalled: boolean;
        falsePositive: boolean;
      }>;
    };

function includesFact(response: string, fact: string): boolean {
  return response.toLocaleLowerCase().includes(fact.toLocaleLowerCase());
}

export function scoreMemoryRecall(
  recallCases: MemoryRecallCase[],
): MemoryRecallScore {
  if (recallCases.length === 0) {
    return {
      kind: "invalid",
      reason: "at least one recall case is required",
    };
  }

  const cases = recallCases.map((recallCase) => ({
    id: recallCase.id,
    recalled:
      recallCase.expected.length === 0 ||
      recallCase.expected.every((fact) =>
        includesFact(recallCase.response, fact),
      ),
    falsePositive: recallCase.forbidden.some((fact) =>
      includesFact(recallCase.response, fact),
    ),
  }));
  const expectedFactCount = recallCases.filter(
    (recallCase) => recallCase.expected.length > 0,
  ).length;
  const truePositiveCount = cases.filter(
    (result, index) =>
      recallCases[index]?.expected.length !== 0 && result.recalled,
  ).length;
  const falseNegativeCount = expectedFactCount - truePositiveCount;
  const falsePositiveCount = cases.filter(
    (result) => result.falsePositive,
  ).length;
  const precisionDenominator = truePositiveCount + falsePositiveCount;

  return {
    kind: "scored",
    caseCount: cases.length,
    expectedFactCount,
    truePositiveCount,
    falseNegativeCount,
    falsePositiveCount,
    precision:
      precisionDenominator === 0 ? 1 : truePositiveCount / precisionDenominator,
    recall: expectedFactCount === 0 ? 1 : truePositiveCount / expectedFactCount,
    falsePositiveRate: falsePositiveCount / cases.length,
    cases,
  };
}
