import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.gift-milestone",
  title:
    "Gift milestone tracks relationship context, date, budget, and delivery",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "relationships", "personal-admin"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gift milestone",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gift-milestone",
      room: "main",
      text: "Prep a relationship milestone gift for Maya: date, preferences from prior messages, budget, delivery deadline, and approval before purchase.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "MESSAGE", "CALENDAR", "LIFE"],
        description: "relationship gift milestone",
        includesAny: ["Maya", "relationship", "gift", "budget", "approval"],
      }),
      responseIncludesAny: ["Maya", /gift|budget|delivery|approval/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should use relationship context and calendar timing, keep purchase approval explicit, and create delivery follow-up.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "MESSAGE", "CALENDAR", "LIFE"],
    },
    {
      type: "custom",
      name: "gift-milestone-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "MESSAGE", "CALENDAR", "LIFE"],
        description: "relationship gift milestone",
        includesAny: ["Maya", "relationship", "gift", "budget", "approval"],
      }),
    },
    judgeRubric({
      name: "executive-gift-milestone-rubric",
      threshold: 0.7,
      description:
        "Agent handles a personal relationship milestone with context, timing, budget, and approval boundary.",
    }),
  ],
});
