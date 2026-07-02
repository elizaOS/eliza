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

const GOAL_INPUT = "Add a goal to run a marathon next year.";
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
        thought: "Create the owner's marathon life goal.",
        messageToUser: "",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-owner-goals",
            name: OWNER_GOALS,
            type: "function",
            arguments: { action: "create", title: "Run a marathon" },
          },
        ],
      },
      times: 1,
    },
    {
      // The action's own resolveActionArgs extraction (a single TEXT_LARGE call).
      name: "owner-goals-extraction-create",
      match: { modelType: ModelType.TEXT_LARGE },
      response: JSON.stringify({
        action: "create",
        params: { title: "Run a marathon" },
        missing: [],
        confidence: 0.95,
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
