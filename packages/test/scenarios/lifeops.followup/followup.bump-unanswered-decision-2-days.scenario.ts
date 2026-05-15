import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.bump-unanswered-decision-2-days",
  title: "Bump an unanswered decision after 2 days with context preserved",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "bump"],
  description:
    "An unanswered decision is sitting 48 hours old. The agent must nudge with the original context attached — not start a fresh ask. Tests the 'preserve context across the bump' contract from PRD §Drive Follow-Through.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "advanceClock",
      by: "48h",
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "open-decision",
        topic: "venue choice for the offsite",
        options: ["Tahoe lodge", "Sea Ranch", "Big Sur cabin"],
        blockedPeople: ["Jordan", "Priya"],
        firstAskedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Bump unanswered decision",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bump-decision",
      room: "main",
      text: "It's been 2 days and I haven't picked an offsite venue. Bump me — Jordan and Priya are blocked.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX", "LIFE"],
        description: "decision bump with context",
        includesAny: ["bump", "venue", "Jordan", "Priya", "offsite"],
      }),
      responseIncludesAny: ["venue", "Jordan", "Priya", "Tahoe", "Sea Ranch"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must reference the original options (venues) AND who is blocked (Jordan, Priya). A generic 'follow up' without context fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["INBOX", "LIFE"],
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
      name: "followup-bump-2d-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX", "LIFE"],
        description: "context-preserving bump",
        includesAny: ["venue", "Jordan", "Priya", "offsite"],
      }),
    },
    {
      type: "custom",
      name: "followup-bump-2d-memory",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "bump preserved with original context",
        contentIncludesAny: ["venue", "Jordan", "Priya"],
      }),
    },
    {
      type: "custom",
      name: "followup-bump-2d-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop", "mobile"],
        description: "bump delivered on a real channel",
      }),
    },
    judgeRubric({
      name: "followup-bump-2d-rubric",
      threshold: 0.7,
      description:
        "Agent bumped the unanswered decision with the original options and blocked-people context. No fresh ask.",
    }),
  ],
});
