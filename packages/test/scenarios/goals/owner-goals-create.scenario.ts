/**
 * Keyless per-plugin e2e for `@elizaos/plugin-goals` (issue #8801).
 *
 * The goals plugin's primary agent-action surface is `OWNER_GOALS`
 * (create | update | delete | review). This drives the create path end-to-end
 * through the deterministic LLM proxy with zero credentials: routing fixtures
 * select the action, a TEXT_LARGE fixture answers the action's own
 * `resolveActionArgs` extraction with a structured `{action, params}` envelope,
 * and the goal is created. The one PA-owned audit table the create path appends
 * to (`app_lifeops.life_audit_events`) is provisioned in the seed so the full
 * create->reply loop runs without pulling all of personal-assistant into the
 * keyless runtime (mirrors plugin-goals' own goals.harness.test.ts).
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { executeRawSql } from "../../../../plugins/plugin-goals/src/db/sql.ts";
import { createOwnerGoalsService } from "../../../../plugins/plugin-goals/src/goals-runtime.ts";

// The create path is a preview->confirm handshake (#14459/#15055):
// `shouldRequireLifeCreateConfirmation` commits only when the create params carry
// `confirmed:true` AND the user's message literally contains an explicit save
// phrase. This single-turn smoke scenario predates the gate, so the message
// carries "save it" and the tool-call args set `confirmed:true`.
const GOAL_INPUT = "Add a goal to run a marathon next year, and save it.";
const OWNER_GOALS = "OWNER_GOALS";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function goalsRouteFixtures(): Array<Record<string, unknown>> {
  const inputMatches = (value: string) => value.includes("marathon");
  return [
    {
      name: "route-owner-goals-stage1",
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: inputMatches,
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: ["general"],
        intents: ["goal"],
        replyText: "",
        threadOps: [],
        candidateActionNames: [OWNER_GOALS],
      },
      times: 1,
    },
    {
      name: "route-owner-goals-planner",
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: inputMatches,
        toolName: OWNER_GOALS,
      },
      response: {
        text: "",
        // Non-empty so the planner-loop gate synthesizes a FINISH after the
        // successful create instead of firing an (unfixtured) in-loop evaluator.
        thought: "Create the owner's marathon life goal.",
        messageToUser: "Added your goal.",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-owner-goals",
            name: OWNER_GOALS,
            type: "function",
            arguments: {
              action: "create",
              title: "Run a marathon",
              confirmed: true,
            },
          },
        ],
      },
      times: 1,
    },
    {
      // The action's own resolveActionArgs extraction. Excludes the grounding
      // prompt (below) so the two TEXT_LARGE fixtures are mutually exclusive, and
      // is optional because the planner already supplied the create args.
      name: "owner-goals-extraction-create",
      match: {
        modelType: ModelType.TEXT_LARGE,
        prompt: (v: string) => !v.includes("missingCriticalFields"),
      },
      response: JSON.stringify({
        action: "create",
        params: { title: "Run a marathon", confirmed: true },
        missing: [],
        confidence: 0.95,
      }),
      times: { min: 0, max: 1 },
    },
    {
      // #14459's second TEXT_LARGE grounding extractor
      // (extractGoalCreatePlanWithLlm). Without a grounded plan the create is a
      // NOOP_GOAL_UNGROUNDED and never persists. successCriteria/supportStrategy
      // MUST be objects — a string/null re-triggers the NOOP gate.
      name: "owner-goals-grounding-create",
      match: {
        modelType: ModelType.TEXT_LARGE,
        prompt: (v: string) => v.includes("missingCriticalFields"),
      },
      response: JSON.stringify({
        mode: "create",
        response: null,
        title: "Run a marathon",
        description: "Train for and complete a marathon within the next year.",
        cadence: { kind: "weekly" },
        successCriteria: {
          summary: "Finish a full 42.2km marathon within the next year.",
        },
        supportStrategy: {
          summary: "Follow a progressive weekly long-run training plan.",
        },
        groundingState: "grounded",
        missingCriticalFields: [],
        confidence: 0.95,
        evaluationSummary: "Completing a marathon within the next year.",
        targetDomain: "fitness",
      }),
      times: 1,
    },
  ];
}

export default scenario({
  lane: "pr-deterministic",
  id: "goals.owner-goals-create",
  title: "Goals: OWNER_GOALS creates a goal from natural language",
  domain: "goals",
  tags: ["smoke", "goals", "owner-goals"],
  description:
    "Sends a create-a-goal message and verifies the OWNER_GOALS action is selected and succeeds with action=create via the deterministic LLM proxy — keyless, no credentials.",

  requires: {
    plugins: ["@elizaos/plugin-goals"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "provision-audit-table-and-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        await executeRawSql(runtime, "CREATE SCHEMA IF NOT EXISTS app_lifeops");
        await executeRawSql(
          runtime,
          `CREATE TABLE IF NOT EXISTS app_lifeops.life_audit_events (
             id text PRIMARY KEY,
             agent_id text NOT NULL,
             event_type text NOT NULL,
             owner_type text NOT NULL,
             owner_id text NOT NULL,
             reason text,
             inputs_json text,
             decision_json text,
             actor text NOT NULL,
             created_at text NOT NULL
           )`,
        );
        runtime.scenarioLlmFixtures?.register(...goalsRouteFixtures());
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Goals: create",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "create-goal",
      text: GOAL_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === OWNER_GOALS,
        );
        if (!call) {
          return `Expected ${OWNER_GOALS} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${OWNER_GOALS} did not succeed: ${
            call.error?.message ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: OWNER_GOALS,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the create action's result must carry the
      // created goal record (goalCountDelta reads result.data.record.goal).
      type: "goalCountDelta",
      title: "Run a marathon",
      delta: 1,
    },
    {
      // Effect proof (#11381): the goal row really exists in the live goals
      // store — read it back through the same repository the action wrote to.
      type: "custom",
      name: "goal-row-persisted-effect",
      predicate: async (ctx) => {
        const service = createOwnerGoalsService(ctx.runtime as AgentRuntime);
        const goals = await service.listGoals();
        const created = goals.find(
          (record) => record.goal.title === "Run a marathon",
        );
        if (!created) {
          const titles =
            goals.map((record) => record.goal.title).join(", ") || "(none)";
          return `goal "Run a marathon" not found in the goals store; stored titles: ${titles}`;
        }
      },
    },
  ],
});
