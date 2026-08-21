/** Scenario fixture for todo routine morning checkin; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectScenarioActionResultData,
  expectTurnToCallAction,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { seedCheckinTodo } from "../../../scenario-support/lifeops-seeds.ts";

export default scenario({
  lane: "live-only",
  id: "todo.routine.morning-checkin",
  title: "Morning check-in surfaces overdue todo context",
  domain: "todos",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "todos", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Morning Check-in",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-overdue-checkin-todo",
      apply: seedCheckinTodo({
        id: "morning-checkin-drink-water",
        title: "Drink water",
        dueAt: "{{now-2h}}",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-checkin",
      text: "Run my morning check-in.",
      responseIncludesAny: ["morning", "overview", "day"],
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHECKIN"],
        description: "morning check-in",
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
      name: "morning-checkin-report-includes-overdue-todo",
      predicate: expectScenarioActionResultData({
        description: "morning check-in report payload",
        actionName: "CHECKIN",
        includesAll: ["morning", "Drink water"],
      }),
    },
  ],
});
