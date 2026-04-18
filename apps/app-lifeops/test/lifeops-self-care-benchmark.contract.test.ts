import { describe, expect, it } from "vitest";
import {
  buildSelfCarePromptBenchmarkCases,
  PROMPT_BENCHMARK_VARIANT_IDS,
  SELF_CARE_HABIT_SCENARIO_IDS,
  SELF_CARE_PRD_SCENARIO_IDS,
} from "./helpers/lifeops-prompt-benchmark-cases.ts";

function groupCaseIdsByScenario(
  cases: Awaited<ReturnType<typeof buildSelfCarePromptBenchmarkCases>>,
): Map<string, typeof cases> {
  const grouped = new Map<string, typeof cases>();
  for (const testCase of cases) {
    const bucket = grouped.get(testCase.baseScenarioId) ?? [];
    bucket.push(testCase);
    grouped.set(testCase.baseScenarioId, bucket);
  }
  return grouped;
}

describe("LifeOps self-care prompt benchmark contracts", () => {
  it("materializes ten benchmark variants for every self-care scenario", async () => {
    const cases = await buildSelfCarePromptBenchmarkCases();
    const grouped = groupCaseIdsByScenario(cases);
    const expectedScenarioIds = [
      ...SELF_CARE_PRD_SCENARIO_IDS,
      ...SELF_CARE_HABIT_SCENARIO_IDS,
    ];

    expect(cases).toHaveLength(
      expectedScenarioIds.length * PROMPT_BENCHMARK_VARIANT_IDS.length,
    );
    expect(Array.from(grouped.keys()).sort()).toEqual(
      [...expectedScenarioIds].sort(),
    );

    for (const scenarioId of expectedScenarioIds) {
      const scenarioCases = grouped.get(scenarioId) ?? [];
      expect(scenarioCases).toHaveLength(PROMPT_BENCHMARK_VARIANT_IDS.length);
      expect(scenarioCases.map((testCase) => testCase.variantId).sort()).toEqual(
        [...PROMPT_BENCHMARK_VARIANT_IDS].sort(),
      );
    }
  });

  it("distinguishes preview-first self-care turns from immediate execution while preserving goal-vs-definition intent", async () => {
    const cases = await buildSelfCarePromptBenchmarkCases();

    for (const testCase of cases) {
      if (testCase.variantId === "subtle-null") {
        continue;
      }

      if (testCase.expectedAction === null) {
        expect(testCase.acceptableActions).toEqual(["REPLY"]);
        expect(testCase.notes ?? "").toMatch(
          /preview\/clarification|subtle non-request/u,
        );
      } else {
        expect(testCase.expectedAction).toBe("LIFE");
        expect(testCase.acceptableActions).toSatisfy((actions: string[]) =>
          actions.every((action) => action === "BLOCK_UNTIL_TASK_COMPLETE"),
        );
      }

      if (testCase.expectedAction === null) {
        expect(testCase.expectedOperation).toBeNull();
      } else if (testCase.baseScenarioId === "goal-sleep-basic") {
        expect(testCase.expectedOperation).toBe("create_goal");
      } else {
        expect(testCase.expectedOperation).toBe("create_definition");
      }
    }
  });

  it("treats first-turn smalltalk warmups as subtle non-requests instead of execution asks", async () => {
    const cases = await buildSelfCarePromptBenchmarkCases();
    const brushTeethSmalltalkDirect = cases.find(
      (testCase) =>
        testCase.baseScenarioId === "brush-teeth-smalltalk-preference" &&
        testCase.variantId === "direct",
    );

    expect(brushTeethSmalltalkDirect).toMatchObject({
      expectedAction: null,
      acceptableActions: ["REPLY"],
      forbiddenActions: ["LIFE"],
      riskClass: "null",
    });
    expect(brushTeethSmalltalkDirect?.notes ?? "").toContain("subtle non-request");
  });

  it("keeps the subtle null slice non-executing and prompt-distinct", async () => {
    const cases = await buildSelfCarePromptBenchmarkCases();
    const nullCases = cases.filter((testCase) => testCase.variantId === "subtle-null");

    expect(nullCases).toHaveLength(
      SELF_CARE_PRD_SCENARIO_IDS.length + SELF_CARE_HABIT_SCENARIO_IDS.length,
    );

    for (const testCase of nullCases) {
      expect(testCase.expectedAction).toBeNull();
      expect(testCase.acceptableActions).toEqual(["REPLY"]);
      expect(testCase.forbiddenActions).toContain("LIFE");
      expect(testCase.prompt).not.toBe(testCase.basePrompt);
      expect(testCase.prompt.toLowerCase()).toContain("do not do this yet");
      expect(testCase.benchmarkContext.toLowerCase()).toContain(
        "avoid executing durable actions",
      );
    }
  });
});
