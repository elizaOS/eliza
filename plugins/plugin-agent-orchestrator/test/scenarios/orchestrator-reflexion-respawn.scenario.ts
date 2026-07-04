/**
 * Scenario-runner scenario asserting a failed verification re-spawns the task with
 * the prior failure's reflection injected into the next sub-agent's goal prompt.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_REFLEXION_RESPAWN,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  registerCalibratedJudgeFixture,
  registerVerifierFixtures,
} from "./_helpers/orchestrator-scenario-harness";

const FAIL_SUMMARY = "the sub-agent never ran the unit tests";
const MISSING_CRITERION = "unit tests pass";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_REFLEXION_RESPAWN,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export default scenario({
  id: "orchestrator-reflexion-respawn",
  lane: "pr-deterministic",
  title:
    "Orchestrator replays a failed attempt's reflection into the retry prompt",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "reflexion", "respawn", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic orchestrator reflexion harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        // One failing verdict drives the single failed verification; the
        // re-spawn does not re-verify.
        registerVerifierFixtures(
          ctx.runtime as Parameters<typeof registerVerifierFixtures>[0],
          ORCHESTRATOR_REFLEXION_RESPAWN,
          [
            {
              passed: false,
              summary: FAIL_SUMMARY,
              missing: [MISSING_CRITERION],
            },
          ],
        );
        // The judge only passes when the persisted post-mortem line (built
        // by the real reflection-persistence path from the failed verify)
        // and the replayed prompt section reached the judge candidate.
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_REFLEXION_RESPAWN,
          [
            `Attempt 1: ${FAIL_SUMMARY}`,
            "--- Past Attempt Failures ---",
            "persisted a post-mortem",
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "fail a verification, then re-spawn and replay the reflection",
      text: "Exercise the orchestrator reflexion re-spawn loop for a proofless completion.",
      actionName: ORCHESTRATOR_REFLEXION_RESPAWN,
      responseIncludesAny: [
        "Past Attempt Failures",
        "persisted a post-mortem",
        "the retry will not repeat the gap",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
        const firstGoalPrompt = String(data?.firstGoalPrompt ?? "");
        const respawnGoalPrompt = String(data?.respawnGoalPrompt ?? "");
        if (firstGoalPrompt.includes("Past Attempt Failures")) {
          return "the clean first spawn prompt must not carry a reflection";
        }
        if (!respawnGoalPrompt.includes("--- Past Attempt Failures ---")) {
          return "expected the re-spawn prompt to inject the Past Attempt Failures section";
        }
        if (!respawnGoalPrompt.includes(`Attempt 1: ${FAIL_SUMMARY}`)) {
          return "expected the re-spawn prompt to replay attempt 1's reflection summary";
        }
        if (!respawnGoalPrompt.includes(`Missing: ${MISSING_CRITERION}.`)) {
          return "expected the re-spawn prompt to name the missing criterion";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_REFLEXION_RESPAWN,
      status: "success",
    },
    {
      type: "custom",
      name: "verification failed before the reflection was replayed",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const events = Array.isArray(data?.events)
          ? data.events.map(String)
          : [];
        if (!events.includes("auto_verify_failed")) {
          return `expected an auto_verify_failed event, saw ${JSON.stringify(events)}`;
        }
        const finalStatuses = data?.finalStatuses as
          | Record<string, unknown>
          | undefined;
        const statuses = Object.values(finalStatuses ?? {});
        if (!statuses.includes("active")) {
          return `expected the task to stay active for the retry, saw ${JSON.stringify(statuses)}`;
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies reflexion replay",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace shows a proofless completion failed verification, a post-mortem was recorded, and the re-spawn goal prompt replayed that prior attempt's reflection under a Past Attempt Failures section.",
    },
  ],
});
