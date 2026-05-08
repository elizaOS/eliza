import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "cross-platform.triage-priority-ranking",
  title: "Rank incoming messages across all channels by priority",
  domain: "messaging.cross-platform",
  tags: ["cross-platform", "triage", "parameter-extraction"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-Platform Triage Priority",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "priority triage",
      room: "main",
      text: "Rank the most important incoming messages across every platform right now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "cross-platform inbox priority ranking",
        includesAny: ["rank", "priority", "important", "incoming"],
      }),
      responseIncludesAny: ["priority", "rank", "important"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must actually prioritize incoming messages instead of just saying the inbox was checked. It should distinguish the most important item or items and explain why they are first.",
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
      includesAny: ["rank", "priority", "important", "incoming"],
    },
    {
      type: "custom",
      name: "cross-platform-triage-priority-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "cross-platform inbox priority ranking",
        includesAny: ["rank", "priority", "important", "incoming"],
      }),
    },
    judgeRubric({
      name: "cross-platform-triage-priority-ranking-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant ranked incoming messages by importance instead of returning an unstructured inbox summary.",
    }),
  ],
});
