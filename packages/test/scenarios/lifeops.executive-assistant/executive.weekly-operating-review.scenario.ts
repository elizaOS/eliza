import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.weekly-operating-review",
  title: "Weekly operating review extracts commitments, risks, and decisions",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "weekly-review", "planning"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Weekly review",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekly-operating-review",
      room: "main",
      text: "Run my weekly operating review: commitments I made, commitments owed to me, schedule pressure, money/admin deadlines, travel risk, and three decisions to make now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "BRIEF",
          "LIFE",
          "CALENDAR",
          "INBOX",
          "PAYMENTS",
          "BOOK_TRAVEL",
        ],
        description: "weekly operating review",
        includesAny: [
          "commitments",
          "schedule",
          "money",
          "travel",
          "decisions",
        ],
      }),
      responseIncludesAny: [/commitment|schedule|money|travel|decision/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must synthesize the week into commitments, pressure, deadlines, travel risk, and a short decision list.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "BRIEF",
        "LIFE",
        "CALENDAR",
        "INBOX",
        "PAYMENTS",
        "BOOK_TRAVEL",
      ],
    },
    {
      type: "custom",
      name: "weekly-operating-review-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "BRIEF",
          "LIFE",
          "CALENDAR",
          "INBOX",
          "PAYMENTS",
          "BOOK_TRAVEL",
        ],
        description: "weekly operating review",
        includesAny: [
          "commitments",
          "schedule",
          "money",
          "travel",
          "decisions",
        ],
      }),
    },
    judgeRubric({
      name: "executive-weekly-operating-review-rubric",
      threshold: 0.7,
      description:
        "Agent produces a true operating review with commitments, owed work, pressure, deadlines, and decisions.",
    }),
  ],
});
