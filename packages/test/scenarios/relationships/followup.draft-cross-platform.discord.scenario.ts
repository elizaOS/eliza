import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "followup.draft-cross-platform.discord",
  title: "Draft a follow-up Discord DM to a Rolodex contact",
  domain: "relationships",
  tags: ["lifeops", "relationships", "cross-platform"],
  description:
    "User asks the assistant to draft a Discord follow-up to a known contact and hold it for approval instead of sending immediately.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: discord follow-up draft",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      handles: [{ platform: "discord", identifier: "alice#1234" }],
      notes: "Acme Inc",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "draft-discord-followup",
      room: "main",
      text: "Draft a follow-up Discord DM to Alice Chen about the Acme Inc partnership update, but hold it for approval.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "discord follow-up draft",
        includesAny: ["Alice", "discord", "follow-up", "approval"],
      }),
      // De-echoed (#9310): the old keywords ("Alice", "draft", "approval",
      // "Discord") all appeared in the user's own turn text. The hold-for-
      // approval contract is asserted in derived words (invite review, never
      // claim delivery); `draftExists` stays the load-bearing outcome.
      responseIncludesAny: ["review", "approve", "sign off", "take a look"],
      responseExcludes: [
        "already sent",
        "has been sent",
        "i've sent",
        "i have sent",
        "sent it",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must draft a Discord follow-up to Alice Chen and explicitly hold it for approval instead of claiming it was already sent.",
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
      channel: "discord",
      expected: true,
    },
    {
      type: "custom",
      name: "followup-draft-discord-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "discord follow-up draft",
        includesAny: ["Alice", "discord", "follow-up", "approval"],
      }),
    },
    judgeRubric({
      name: "followup-draft-discord-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Discord follow-up to Alice Chen and held it for approval instead of sending it blindly.",
    }),
  ],
});
