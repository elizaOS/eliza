import { describe, expect, it } from "vitest";
import { intentSyncAction } from "../src/actions/intent-sync.ts";
import { appLifeOpsPlugin } from "../src/plugin.ts";
import { actionsAreScenarioEquivalent } from "../../../packages/scenario-runner/src/action-families.ts";
import {
  buildExecutiveAssistantPromptBenchmarkCases,
  loadExecutiveAssistantCatalog,
  PROMPT_BENCHMARK_VARIANT_IDS,
} from "./helpers/lifeops-prompt-benchmark-cases.ts";

function groupCasesByScenario(
  cases: Awaited<ReturnType<typeof buildExecutiveAssistantPromptBenchmarkCases>>,
): Map<string, typeof cases> {
  const grouped = new Map<string, typeof cases>();
  for (const testCase of cases) {
    const bucket = grouped.get(testCase.baseScenarioId) ?? [];
    bucket.push(testCase);
    grouped.set(testCase.baseScenarioId, bucket);
  }
  return grouped;
}

describe("LifeOps executive-assistant prompt benchmark contracts", () => {
  it("materializes ten benchmark variants for every transcript-derived scenario", async () => {
    const [catalog, cases] = await Promise.all([
      loadExecutiveAssistantCatalog(),
      buildExecutiveAssistantPromptBenchmarkCases(),
    ]);
    const grouped = groupCasesByScenario(cases);
    const scenarioIds = catalog.scenarios.map((scenario) => scenario.id).sort();

    expect(cases).toHaveLength(
      catalog.scenarios.length * PROMPT_BENCHMARK_VARIANT_IDS.length,
    );
    expect(Array.from(grouped.keys()).sort()).toEqual(scenarioIds);

    for (const scenarioId of scenarioIds) {
      const scenarioCases = grouped.get(scenarioId) ?? [];
      expect(scenarioCases).toHaveLength(PROMPT_BENCHMARK_VARIANT_IDS.length);
      expect(scenarioCases.map((testCase) => testCase.variantId).sort()).toEqual(
        [...PROMPT_BENCHMARK_VARIANT_IDS].sort(),
      );
    }
  });

  it("derives executable action expectations for positive variants and strict no-execute null cases", async () => {
    const cases = await buildExecutiveAssistantPromptBenchmarkCases();
    const grouped = groupCasesByScenario(cases);

    for (const scenarioCases of grouped.values()) {
      const directCase = scenarioCases.find((testCase) => testCase.variantId === "direct");
      const nullCase = scenarioCases.find(
        (testCase) => testCase.variantId === "subtle-null",
      );

      expect(directCase?.expectedAction).not.toBeNull();
      expect(directCase?.forbiddenActions ?? []).toEqual([]);
      expect(String(directCase?.benchmarkContext).toLowerCase()).toContain(
        "prefer executing the best matching registered action",
      );
      expect(String(directCase?.benchmarkContext)).not.toContain(
        String(directCase?.caseId ?? ""),
      );
      expect(String(directCase?.benchmarkContext)).not.toContain(
        String(directCase?.baseScenarioId ?? ""),
      );
      expect(String(directCase?.benchmarkContext).toLowerCase()).toContain(
        "registered runtime action",
      );

      expect(nullCase?.expectedAction).toBeNull();
      expect(nullCase?.acceptableActions).toEqual(["REPLY"]);
      expect(nullCase?.forbiddenActions).toEqual(
        expect.arrayContaining([String(directCase?.expectedAction ?? "")]),
      );
      expect(String(nullCase?.benchmarkContext).toLowerCase()).toContain(
        "avoid executing durable actions",
      );
      expect(String(nullCase?.benchmarkContext)).not.toContain(
        String(nullCase?.caseId ?? ""),
      );
    }
  });

  it("keeps prompts unique per variant instead of duplicating the base transcript phrasing", async () => {
    const cases = await buildExecutiveAssistantPromptBenchmarkCases();

    for (const scenarioCases of groupCasesByScenario(cases).values()) {
      const prompts = scenarioCases.map((testCase) => testCase.prompt);
      expect(new Set(prompts).size).toBe(prompts.length);

      const nullCase = scenarioCases.find(
        (testCase) => testCase.variantId === "subtle-null",
      );
      expect(nullCase?.prompt).not.toBe(nullCase?.basePrompt);
      expect(String(nullCase?.prompt).toLowerCase()).toContain(
        "do not do this yet",
      );
    }
  });

  it("keeps every benchmark case aligned with at least one registered LifeOps plugin action", async () => {
    const actionNames = new Set(
      (appLifeOpsPlugin.actions ?? []).map((action) => action.name),
    );
    // INTENT_SYNC is the canonical cross-device broadcast action. The legacy
    // PUBLISH_DEVICE_INTENT alias was folded into it as a simile (see commit
    // efb970f60b). Reference the imported action so this check tracks the
    // single source of truth instead of a duplicated string.
    expect(actionNames.has(intentSyncAction.name)).toBe(true);
    const cases = await buildExecutiveAssistantPromptBenchmarkCases();
    for (const testCase of cases) {
      const acceptedAnchors = [
        testCase.expectedAction,
        ...testCase.acceptableActions,
      ].filter((actionName): actionName is string => Boolean(actionName));

      const hasCompatibleSurfaceAction = acceptedAnchors.some((benchmarkAction) =>
        benchmarkAction === "REPLY" ||
        Array.from(actionNames).some(
          (registeredActionName) =>
            actionsAreScenarioEquivalent(benchmarkAction, registeredActionName) ||
            benchmarkAction === registeredActionName,
        ),
      );
      expect(hasCompatibleSurfaceAction).toBe(true);
    }
  });

  it("honors explicit benchmark prompt overrides when a transcript turn is not the canonical owner prompt", async () => {
    const cases = await buildExecutiveAssistantPromptBenchmarkCases();
    const bookAfterApproval = cases.find(
      (testCase) => testCase.caseId === "ea.travel.book-after-approval__direct",
    );

    expect(bookAfterApproval?.basePrompt).toContain(
      "hold it for my approval before you book anything",
    );
  });
});
