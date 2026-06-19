import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.people-cadence",
  title: "People cadence prepares relationship touchpoints",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "relationships", "cadence"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "People cadence",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "people-cadence",
      room: "main",
      text: "Prepare relationship touchpoints: overdue cadences, milestones, promises I made, shared threads, and open asks. Keep suggestions brief.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "MESSAGE", "LIFE", "INBOX"],
        description: "people cadence review",
        includesAny: ["cadence", "milestone", "promise", "thread", "open ask"],
      }),
      responseIncludesAny: [/cadence|milestone|promise|touchpoint|ask/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must produce brief relationship touchpoints grounded in cadence, milestones, promises, shared threads, or open asks.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "MESSAGE", "LIFE", "INBOX"],
    },
    {
      type: "custom",
      name: "people-cadence-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "MESSAGE", "LIFE", "INBOX"],
        description: "people cadence review",
        includesAny: ["cadence", "milestone", "promise", "thread", "open ask"],
      }),
    },
    judgeRubric({
      name: "executive-people-cadence-rubric",
      threshold: 0.7,
      description:
        "Agent prepares concise relationship touchpoints rather than generic networking advice.",
    }),
  ],
});
