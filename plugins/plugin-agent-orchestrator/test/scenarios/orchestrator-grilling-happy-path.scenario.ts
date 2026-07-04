/**
 * Scenario-runner (pr-deterministic) twin of the live grilling scenario: a
 * no-evidence 'done' is grilled, then verified once passing test output is pasted.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_GRILLING_HAPPY_PATH,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  registerCalibratedJudgeFixture,
  registerVerifierFixtures,
} from "./_helpers/orchestrator-scenario-harness";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_GRILLING_HAPPY_PATH,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export default scenario({
  id: "orchestrator-grilling-happy-path",
  lane: "pr-deterministic",
  title:
    "Orchestrator grills proofless completions and accepts proven re-report",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "grilling", "multi-agent", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic orchestrator grilling harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        registerVerifierFixtures(
          ctx.runtime as Parameters<typeof registerVerifierFixtures>[0],
          ORCHESTRATOR_GRILLING_HAPPY_PATH,
          [
            {
              passed: false,
              summary:
                "The completion claimed success but did not paste the required test output.",
              missing: ["tests pass with pasted output"],
            },
            {
              passed: true,
              summary: "All acceptance criteria are backed by concrete proof.",
              missing: [],
            },
          ],
        );
        // The judge only passes when the harness's real end-state summary
        // (produced after auto_verify_failed + validation_passed were
        // observed) reached the judge candidate. None of these strings
        // appear in the scenario turn text.
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_GRILLING_HAPPY_PATH,
          [
            "corrective evidence checklist was sent",
            "Tests 4 passed (4)",
            "passed validation",
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "drive proofless completion through the grill and re-report",
      text: "Exercise the orchestrator grilling loop for a proofless completion.",
      actionName: ORCHESTRATOR_GRILLING_HAPPY_PATH,
      responseIncludesAny: [
        "grill round fired",
        "evidence checklist",
        "accepted the re-report",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
        const correctivePrompt = String(data?.correctivePrompt ?? "");
        const verifierPrompts = Array.isArray(data?.verifierPrompts)
          ? data.verifierPrompts.map(String)
          : [];
        if (
          !correctivePrompt.includes("Automatic verification did not confirm")
        ) {
          return "expected the corrective grill prompt to be sent to the sub-agent";
        }
        if (!correctivePrompt.includes("Evidence checklist")) {
          return "expected the corrective prompt to include the evidence checklist";
        }
        if (
          !verifierPrompts.some((prompt) =>
            prompt.includes("I finished the cache fix; tests should be good."),
          )
        ) {
          return "expected first verifier prompt to contain the proofless completion";
        }
        if (
          !verifierPrompts.some((prompt) =>
            prompt.includes("Tests 4 passed (4)"),
          )
        ) {
          return "expected second verifier prompt to contain pasted test output";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_GRILLING_HAPPY_PATH,
      status: "success",
    },
    {
      type: "custom",
      name: "task finished only after validation passed",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const finalStatuses = data?.finalStatuses as
          | Record<string, unknown>
          | undefined;
        const statuses = Object.values(finalStatuses ?? {});
        if (!statuses.includes("done")) {
          return `expected final task status done, saw ${JSON.stringify(statuses)}`;
        }
        const events = Array.isArray(data?.events)
          ? data.events.map(String)
          : [];
        for (const event of ["auto_verify_failed", "validation_passed"]) {
          if (!events.includes(event)) return `expected event ${event}`;
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies grilling behavior",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace shows a proofless sub-agent completion failed verification, a corrective evidence checklist was sent, and a later completion with test output passed validation.",
    },
  ],
});
