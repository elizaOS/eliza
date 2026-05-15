import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.draft-cross-platform.gmail",
  title: "Draft a follow-up email to a Rolodex contact",
  domain: "relationships",
  tags: ["lifeops", "relationships", "cross-platform"],
  description:
    "User asks the assistant to draft a Gmail follow-up to a known contact and hold it for approval instead of sending immediately.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: gmail follow-up draft",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      handles: [{ platform: "gmail", identifier: "alice@acme.example.com" }],
      notes: "Acme Inc",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "draft-gmail-followup",
      room: "main",
      text: "Draft a follow-up email to Alice Chen at alice@acme.example.com about the Acme Inc partnership update, but hold it for approval.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "gmail follow-up draft",
        includesAny: ["Alice", "gmail", "follow-up", "approval"],
      }),
      responseIncludesAny: ["Alice", "draft", "approval", "email"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must draft a Gmail follow-up to Alice Chen and explicitly hold it for approval instead of claiming it was already sent.",
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
      channel: "gmail",
      expected: true,
    },
    {
      type: "custom",
      name: "followup-draft-gmail-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "gmail follow-up draft",
        includesAny: ["Alice", "gmail", "follow-up", "approval"],
      }),
    },
    judgeRubric({
      name: "followup-draft-gmail-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Gmail follow-up to Alice Chen and held it for approval instead of sending it blindly.",
    }),
  ],
});
