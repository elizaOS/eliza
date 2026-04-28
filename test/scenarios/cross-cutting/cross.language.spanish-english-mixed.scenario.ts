/**
 * i18n / language test: the user asks (in Spanish) the agent to create a
 * task. The agent must route to a task-creation action and the response
 * should be in Spanish or at minimum preserve the Spanish title.
 */

import { scenario } from "@elizaos/scenario-schema";

const TODO_CREATE_ACTIONS = ["CREATE_TASK", "LIFE"];

export default scenario({
  id: "cross.language.spanish-english-mixed",
  title: "Spanish-language task-creation request routes correctly",
  domain: "cross-cutting",
  tags: ["cross-cutting", "i18n", "critical"],
  description:
    "User asks in Spanish to create a task called 'llamar a mamá'. The agent must route to CREATE_TASK or LIFE and its response should either be in Spanish or include the task title verbatim.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: Spanish input",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "create-task-spanish",
      room: "main",
      text: "¿Puedes crear una tarea llamada 'llamar a mamá'?",
      responseIncludesAny: [
        "llamar a mamá",
        "llamar a mama",
        /tarea/i,
        "mamá",
        "mom",
      ],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find((a) =>
          TODO_CREATE_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected one of [${TODO_CREATE_ACTIONS.join(", ")}] but got: ${fired}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "task-create-action-fired",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((a) =>
          TODO_CREATE_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          return `No task-create action fired. Accepted: ${TODO_CREATE_ACTIONS.join(", ")}`;
        }
      },
    },
  ],
});
