import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.expense-capture",
  title:
    "Expense capture groups receipts and asks only for missing classifications",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "expenses", "money"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Expense capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "capture-expenses",
      room: "main",
      text: "Collect likely reimbursable expenses from last week's client trip. Use receipts, card charges, calendar travel, and inbox confirmations; ask only for missing classifications.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "PAYMENTS",
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "CALENDAR",
          "LIFE",
        ],
        description: "expense capture workflow",
        includesAny: [
          "reimbursable",
          "receipts",
          "card",
          "calendar",
          "inbox",
          "classification",
        ],
      }),
      responseIncludesAny: [/receipt|card|expense|reimburs/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must group likely reimbursable expenses and ask only about missing classifications. It should not ask the user to manually re-enter everything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "PAYMENTS",
        "OWNER_DOCUMENTS",
        "MESSAGE",
        "CALENDAR",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "expense-capture-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "PAYMENTS",
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "CALENDAR",
          "LIFE",
        ],
        description: "expense capture workflow",
        includesAny: [
          "reimbursable",
          "receipts",
          "card",
          "calendar",
          "inbox",
          "classification",
        ],
      }),
    },
    judgeRubric({
      name: "executive-expense-capture-rubric",
      threshold: 0.7,
      description:
        "Agent captures expenses from available sources and limits questions to missing classifications.",
    }),
  ],
});
