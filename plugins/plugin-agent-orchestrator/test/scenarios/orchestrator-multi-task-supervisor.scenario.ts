/**
 * Scenario-runner (pr-deterministic) scenario asserting the task supervisor's
 * cross-task digest surfaces the state of several concurrent orchestrator tasks.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  registerCalibratedJudgeFixture,
} from "./_helpers/orchestrator-scenario-harness";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export default scenario({
  id: "orchestrator-multi-task-supervisor",
  lane: "pr-deterministic",
  title: "Orchestrator isolates concurrent tasks and posts a supervisor digest",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "multi-task", "supervisor", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic multi-task harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        // The judge only passes when the real forwarding target (a live
        // harness session id) and the supervisor digest's task titles
        // reached the judge candidate. None appear in the turn text.
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
          [
            "forwarded only to orchestrator-scenario-session-",
            "Alpha transcript parser",
            "Beta browser callback",
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "run concurrent tasks with isolation and digest",
      text: "Exercise concurrent orchestrator tasks with supervisor digest.",
      actionName: ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
      responseIncludesAny: [
        "two active tasks stayed isolated",
        "supervisor emitted one room digest",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
        const forwardedTo = Array.isArray(data?.forwardedTo)
          ? data.forwardedTo.map(String)
          : [];
        if (forwardedTo.length !== 1) {
          return `expected exactly one forwarded session, saw ${JSON.stringify(forwardedTo)}`;
        }
        const digest = String(data?.digest ?? "");
        for (const needle of [
          "Task update",
          "Alpha transcript parser",
          "Beta browser callback",
        ]) {
          if (!digest.includes(needle)) {
            return `expected supervisor digest to include ${needle}`;
          }
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
      status: "success",
    },
    {
      type: "custom",
      name: "two isolated active tasks were summarized",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const taskIds = Array.isArray(data?.taskIds)
          ? data.taskIds.map(String)
          : [];
        const sessionIds = Array.isArray(data?.sessionIds)
          ? data.sessionIds.map(String)
          : [];
        if (taskIds.length !== 2 || sessionIds.length !== 2) {
          return `expected two tasks and sessions, saw tasks=${taskIds.length} sessions=${sessionIds.length}`;
        }
        const digest = String(data?.digest ?? "");
        if (!digest.includes("2 active")) {
          return `expected digest to summarize two active tasks, saw ${digest}`;
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies multi-task supervision",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace shows two concurrent orchestrator tasks, a user message forwarded only to the intended sub-agent, and a supervisor digest covering both active tasks.",
    },
  ],
});
