import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.waiting-on-cross-channel",
  title: "Waiting-on review finds delegated work across channels",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "waiting-on", "cross-channel"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Waiting-on review",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "waiting-on-review",
      room: "main",
      text: "Find what I'm waiting on across email, Telegram, Discord, docs, and calendar. Draft the smallest set of follow-ups without duplicating active tasks.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "MESSAGE",
          "INBOX",
          "RELATIONSHIP",
          "LIFE",
          "OWNER_DOCUMENTS",
          "CALENDAR",
        ],
        description: "cross-channel waiting-on review",
        includesAny: [
          "waiting",
          "follow-up",
          "email",
          "Telegram",
          "Discord",
          "docs",
        ],
      }),
      responseIncludesAny: [/waiting|follow/i, /email|telegram|discord|doc/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should identify waiting-on items and propose a small deduplicated follow-up set across multiple channels.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "MESSAGE",
        "INBOX",
        "RELATIONSHIP",
        "LIFE",
        "OWNER_DOCUMENTS",
        "CALENDAR",
      ],
    },
    {
      type: "custom",
      name: "waiting-on-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "MESSAGE",
          "INBOX",
          "RELATIONSHIP",
          "LIFE",
          "OWNER_DOCUMENTS",
          "CALENDAR",
        ],
        description: "cross-channel waiting-on review",
        includesAny: [
          "waiting",
          "follow-up",
          "email",
          "Telegram",
          "Discord",
          "docs",
        ],
      }),
    },
    judgeRubric({
      name: "executive-waiting-on-rubric",
      threshold: 0.7,
      description:
        "Agent deduplicates waiting-on work and proposes minimal follow-ups across channels.",
    }),
  ],
});
