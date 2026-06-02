import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.hiring-loop",
  title:
    "Hiring loop coordinates interview schedule, docs, panel, and follow-up",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "hiring", "calendar"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Hiring loop",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "hiring-loop",
      room: "main",
      text: "Prep the VP Product hiring loop: interview calendar, candidate docs, panel owner reminders, scorecard deadline, and follow-up messages.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "OWNER_DOCUMENTS", "MESSAGE", "LIFE"],
        description: "hiring loop coordination",
        includesAny: ["hiring", "interview", "docs", "scorecard", "follow-up"],
      }),
      responseIncludesAny: [/hiring|interview/i, /doc|scorecard|follow/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should coordinate interview calendar, candidate docs, panel owners, scorecard deadline, and follow-up messages.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "OWNER_DOCUMENTS", "MESSAGE", "LIFE"],
    },
    {
      type: "custom",
      name: "hiring-loop-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "OWNER_DOCUMENTS", "MESSAGE", "LIFE"],
        description: "hiring loop coordination",
        includesAny: ["hiring", "interview", "docs", "scorecard", "follow-up"],
      }),
    },
    judgeRubric({
      name: "executive-hiring-loop-rubric",
      threshold: 0.7,
      description:
        "Agent coordinates a hiring loop with calendar, documents, owners, scorecards, and follow-ups.",
    }),
  ],
});
