import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.inbox.priority-ranks-urgent-before-low",
  title: "Rank urgent blockers ahead of low-priority noise",
  domain: "executive-assistant",
  tags: ["executive-assistant", "briefing", "triage", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant should put urgent blockers first and demote low-value inbound.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Priority Briefing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "priority-brief",
      room: "main",
      text: "Show me the urgent blockers first and separate them from low-priority inbound.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "priority-ranked inbox brief",
        includesAny: ["urgent", "low", "priority", "blocker"],
      }),
      responseIncludesAny: [
        "urgent",
        "low priority",
        "blocker",
        "first",
        "inbound",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must explicitly separate urgent blockers from low-priority inbound, listing the urgent items first. The two buckets must not be merged into a single chronological dump. If no urgent items exist the reply must state that explicitly.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "MESSAGE"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      includesAny: ["urgent", "low", "priority", "blocker"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-priority-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "priority-ranked inbox brief",
        includesAny: ["urgent", "low", "priority", "blocker"],
      }),
    },
    {
      type: "custom",
      name: "ea-priority-memory-write",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "ranked brief is persisted for follow-up",
      }),
    },
    judgeRubric({
      name: "ea-priority-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced a two-bucket prioritised brief (urgent vs low) reflecting actual inbox state, not just a generic prompt for triage.",
    }),
  ],
});
