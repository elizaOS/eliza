/**
 * Scenario-runner scenario asserting a completed coding task emits the full
 * completion evidence bundle (changeset, logs, verification verdict).
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_EVIDENCE_BUNDLE,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  registerCalibratedJudgeFixture,
  registerVerifierFixtures,
} from "./_helpers/orchestrator-scenario-harness";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_EVIDENCE_BUNDLE,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export default scenario({
  id: "orchestrator-evidence-bundle",
  lane: "pr-deterministic",
  title: "Orchestrator verifier receives diff, test output, and URL evidence",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "evidence", "verification", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic evidence bundle harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        registerVerifierFixtures(
          ctx.runtime as Parameters<typeof registerVerifierFixtures>[0],
          ORCHESTRATOR_EVIDENCE_BUNDLE,
          [
            {
              passed: true,
              summary:
                "The changeset, test output, and verified URL prove every criterion.",
              missing: [],
            },
          ],
        );
        // The judge only passes when the diff-stat, pasted test output, and
        // verified URL from the harness's validated end-state summary
        // reached the judge candidate. None appear in the turn text.
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_EVIDENCE_BUNDLE,
          [
            "## CHANGESET src/cache.ts",
            "Tests 8 passed (8)",
            "https://app.example.com/cache",
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "prove the verifier saw the rich completion evidence",
      text: "Exercise the orchestrator completion-evidence bundle.",
      actionName: ORCHESTRATOR_EVIDENCE_BUNDLE,
      responseIncludesAny: [
        "diff, test stdout, and verified URL reached",
        "validation passed",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
        const prompt = Array.isArray(data?.verifierPrompts)
          ? data.verifierPrompts.map(String).join("\n")
          : "";
        for (const needle of [
          "## CHANGESET",
          "src/cache.ts",
          "Tests 8 passed (8)",
          "https://app.example.com/cache",
        ]) {
          if (!prompt.includes(needle)) {
            return `expected verifier prompt to include ${needle}`;
          }
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_EVIDENCE_BUNDLE,
      status: "success",
    },
    {
      type: "custom",
      name: "verifier prompt contains all evidence classes",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const prompt = Array.isArray(data?.verifierPrompts)
          ? data.verifierPrompts.map(String).join("\n")
          : "";
        const missing = [
          "## CHANGESET",
          "1 file changed, 20 insertions(+)",
          "## TEST / BUILD / TYPECHECK OUTPUT",
          "Tests 8 passed (8)",
          // #11012: a URL the sub-agent merely PASTED is surfaced as an
          // explicit unverified claim, never as probe-verified evidence.
          "## CLAIMED URLS",
          "NOT probe-verified",
          "https://app.example.com/cache",
        ].filter((needle) => !prompt.includes(needle));
        if (missing.length > 0) {
          return `missing verifier evidence: ${missing.join(", ")}`;
        }
        // Nothing was probed in this run — a VERIFIED URLS section would
        // mean the prose-mentioned URL got mislabeled again (#11012).
        return prompt.includes("## VERIFIED URLS")
          ? "unprobed pasted URL was mislabeled as probe-verified (## VERIFIED URLS present)"
          : undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies evidence bundle",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace proves the verifier prompt included concrete changeset evidence, passing test output, and surfaced the sub-agent's pasted URL as an explicitly unverified claim before validation passed.",
    },
  ],
});
