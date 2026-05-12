import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.followup.bump-unanswered-decision",
  title: "Bump an unanswered decision that is blocking other people",
  domain: "executive-assistant",
  tags: ["executive-assistant", "followup", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant keeps bumping a scheduling or event decision until it is resolved.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "advanceClock",
      by: "48h",
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Bump Unanswered Decision",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-bump-policy",
      room: "main",
      text: "If I still haven't answered about those three events, bump me again with context instead of starting over.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX", "LIFE"],
        description: "decision follow-up tracking",
        includesAny: ["bump", "context", "events", "follow"],
      }),
      responseIncludesAny: ["bump", "again", "context", "events", "follow up"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must agree to bump the user about the unanswered decision with preserved prior context (not a fresh ask from zero). It should reference the three events or the blocking other people. A generic 'noted' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["INBOX", "LIFE"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["INBOX", "LIFE"],
      includesAny: ["bump", "context", "events"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["dashboard", "desktop", "mobile"],
    },
    {
      type: "custom",
      name: "ea-bump-unanswered-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX", "LIFE"],
        description: "decision follow-up tracking",
        includesAny: ["bump", "context", "events", "follow"],
      }),
    },
    {
      type: "custom",
      name: "ea-bump-unanswered-memory-write",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "follow-up policy is stored so the bump survives across turns",
        contentIncludesAny: ["bump", "context", "events"],
      }),
    },
    {
      type: "custom",
      name: "ea-bump-unanswered-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop", "mobile"],
        description: "bump is actually delivered to the user on a real channel",
      }),
    },
    judgeRubric({
      name: "ea-bump-unanswered-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant registered a bump policy (preserving prior context) and delivered a nudge to the user on an actual channel, rather than restarting the decision conversation.",
    }),
  ],
});
