import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "selfcontrol.block-until-task-complete",
  title: "Block X.com until the workout todo is marked complete",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "todo-gated", "focus"],
  description:
    "User asks the agent to block a site until a workout todo is complete. The action should create or reuse the todo and install a task-gated block rule instead of a fixed-duration block.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Block Until Complete",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-conditional-block",
      room: "main",
      text: "Block X.com until I finish my workout.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BLOCK_UNTIL_TASK_COMPLETE"],
        description: "todo-gated website block",
        includesAny: ["x.com", "workout", "todo"],
      }),
      responseIncludesAny: ["workout", "block", "x"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must make clear this is a task-gated website block tied to finishing the workout, not just a generic timed focus block.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BLOCK_UNTIL_TASK_COMPLETE",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "BLOCK_UNTIL_TASK_COMPLETE",
      includesAny: ["x.com", "workout"],
    },
    {
      type: "custom",
      name: "block-until-task-complete-side-effects",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "BLOCK_UNTIL_TASK_COMPLETE",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as Record<string, unknown>)
            : null;
        if (!data) {
          return "BLOCK_UNTIL_TASK_COMPLETE did not return structured result data";
        }
        if (typeof data.ruleId !== "string" || data.ruleId.length === 0) {
          return "BLOCK_UNTIL_TASK_COMPLETE did not return a block rule id";
        }
        if (typeof data.todoId !== "string" || data.todoId.length === 0) {
          return "BLOCK_UNTIL_TASK_COMPLETE did not return a gated todo id";
        }
      },
    },
    {
      type: "custom",
      name: "block-until-task-complete-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BLOCK_UNTIL_TASK_COMPLETE"],
        description: "todo-gated website block",
        includesAny: ["x.com", "workout", "todo"],
      }),
    },
    judgeRubric({
      name: "block-until-task-complete-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant set up a website block that is explicitly tied to finishing the workout task instead of using a generic timed block.",
    }),
  ],
});
