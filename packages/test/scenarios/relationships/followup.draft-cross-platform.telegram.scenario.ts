import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.draft-cross-platform.telegram",
  title: "Draft a follow-up Telegram DM to a Rolodex contact",
  domain: "relationships",
  tags: ["lifeops", "relationships", "cross-platform"],
  description:
    "User asks the assistant to draft a Telegram follow-up to a known contact and hold it for approval instead of sending immediately.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: telegram follow-up draft",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      handles: [{ platform: "telegram", identifier: "@alicechen" }],
      notes: "Acme Inc",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "draft-telegram-followup",
      room: "main",
      text: "Draft a follow-up Telegram message to Alice Chen about the Acme Inc partnership update, but hold it for approval.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "telegram follow-up draft",
        includesAny: ["Alice", "telegram", "follow-up", "approval"],
      }),
      responseIncludesAny: ["Alice", "draft", "approval", "Telegram"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must draft a Telegram follow-up to Alice Chen and explicitly hold it for approval instead of claiming it was already sent.",
      },
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "MESSAGE"],
    },
    {
      type: "draftExists",
      channel: "telegram",
      expected: true,
    },
    {
      type: "custom",
      name: "followup-draft-telegram-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "telegram follow-up draft",
        includesAny: ["Alice", "telegram", "follow-up", "approval"],
      }),
    },
    judgeRubric({
      name: "followup-draft-telegram-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Telegram follow-up to Alice Chen and held it for approval instead of sending it blindly.",
    }),
  ],
});
