import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.chief-of-staff-handoff",
  title: "Chief-of-staff handoff compresses priorities, owners, and risks",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "handoff", "status"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Chief-of-staff handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "handoff-brief",
      room: "main",
      text: "Build a handoff brief for my chief of staff: weekly priorities, delegated owners, blocked decisions, relationship follow-ups, and status risks.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "RELATIONSHIP", "MESSAGE"],
        description: "chief-of-staff handoff",
        includesAny: ["handoff", "weekly", "delegated", "blocked", "status"],
      }),
      responseIncludesAny: [/handoff|chief of staff/i, /owner|blocked|status/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should be a compact handoff with priorities, owners, blocked decisions, relationship follow-ups, and risks.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BRIEF", "LIFE", "RELATIONSHIP", "MESSAGE"],
    },
    {
      type: "custom",
      name: "chief-of-staff-handoff-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "RELATIONSHIP", "MESSAGE"],
        description: "chief-of-staff handoff",
        includesAny: ["handoff", "weekly", "delegated", "blocked", "status"],
      }),
    },
    judgeRubric({
      name: "executive-chief-of-staff-handoff-rubric",
      threshold: 0.7,
      description:
        "Agent produces a useful chief-of-staff handoff instead of a generic status update.",
    }),
  ],
});
