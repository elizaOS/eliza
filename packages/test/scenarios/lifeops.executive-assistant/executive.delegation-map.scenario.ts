import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.delegation-map",
  title: "Delegation map identifies owners, blockers, and next asks",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "delegation", "relationships"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Delegation map",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delegation-map",
      room: "main",
      text: "Map delegated work for launch week: owner, current blocker, last touch, next ask, and whether I should nudge, wait, or take it back.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "RELATIONSHIP",
          "MESSAGE",
          "LIFE",
          "INBOX",
          "WORK_THREAD",
        ],
        description: "delegation map",
        includesAny: ["delegated", "owner", "blocker", "nudge", "take it back"],
      }),
      responseIncludesAny: [/owner|delegat/i, /blocker|nudge|wait/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must map delegated work into owners, blockers, last touch, next ask, and recommended posture.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "MESSAGE", "LIFE", "INBOX", "WORK_THREAD"],
    },
    {
      type: "custom",
      name: "delegation-map-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "RELATIONSHIP",
          "MESSAGE",
          "LIFE",
          "INBOX",
          "WORK_THREAD",
        ],
        description: "delegation map",
        includesAny: ["delegated", "owner", "blocker", "nudge", "take it back"],
      }),
    },
    judgeRubric({
      name: "executive-delegation-map-rubric",
      threshold: 0.7,
      description:
        "Agent turns scattered delegated work into a compact ownership map and next-action posture.",
    }),
  ],
});
