import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";
import { seedCheckinTodo } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "todo.forceful-reminder.morning-routine",
  title: "Morning check-in reports several overdue routine todos",
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
      title: "LifeOps Todos Forceful Morning Routine",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-brush-teeth",
      apply: seedCheckinTodo({
        id: "forceful-routine-brush-teeth",
        title: "Brush teeth",
        dueAt: "{{now-30m}}",
      }),
    },
    {
      type: "custom",
      name: "seed-stretch",
      apply: seedCheckinTodo({
        id: "forceful-routine-stretch",
        title: "Stretch",
        dueAt: "{{now-45m}}",
      }),
    },
    {
      type: "custom",
      name: "seed-vitamins",
      apply: seedCheckinTodo({
        id: "forceful-routine-vitamins",
        title: "Take vitamins",
        dueAt: "{{now-1h}}",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-routine-push",
      text: "Run my morning check-in.",
      responseIncludesAny: ["morning", "overview", "day"],
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHECKIN"],
        description: "morning check-in with multiple overdue todos",
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
      name: "morning-checkin-includes-all-overdue-routine-todos",
      predicate: expectScenarioActionResultData({
        description: "morning check-in payload with multiple overdue todos",
        actionName: "CHECKIN",
        includesAll: ["Brush teeth", "Stretch", "Take vitamins"],
      }),
    },
  ],
});
