import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";
import { seedCheckinTodo } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "todo.routine.night-checkin",
  title: "Night check-in reports outstanding overdue todo context",
  domain: "todos",
  tags: ["lifeops", "todos"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Night Check-in",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-overdue-checkin-todo",
      apply: seedCheckinTodo({
        id: "night-checkin-journal",
        title: "Journal",
        dueAt: "{{now-1h}}",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "night-checkin",
      text: "Give me my night check-in.",
      responseIncludesAny: ["summary", "day"],
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHECKIN"],
        description: "night check-in",
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "CHECKIN",
    },
    {
      type: "custom",
      name: "night-checkin-report-includes-overdue-todo",
      predicate: expectScenarioActionResultData({
        description: "night check-in report payload",
        actionName: "CHECKIN",
        includesAll: ["night", "Journal"],
      }),
    },
  ],
});
