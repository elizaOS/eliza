/** Exercises approval-gated Gmail draft construction without claiming connector delivery. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "followup.draft.gmail",
  title: "Create an approval-gated Gmail follow-up draft",
  domain: "relationships",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "relationships", "gmail", "draft"],
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
        acceptedActions: ["MESSAGE"],
        description: "gmail follow-up draft",
        includesAny: ["Alice", "gmail", "follow-up", "approval"],
      }),
      // De-echoed (#9310): the old keywords ("Alice", "draft", "approval",
      // "email") all appeared in the user's own turn text. The hold-for-
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
          "The reply must draft a Gmail follow-up to Alice Chen and explicitly hold it for approval instead of claiming it was already sent.",
      },
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
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
        acceptedActions: ["MESSAGE"],
        description: "gmail follow-up draft",
        includesAny: ["Alice", "gmail", "follow-up", "approval"],
      }),
    },
    judgeRubric({
      name: "followup-draft-gmail-rubric",
      threshold: 0.7,
      description:
        "The assistant constructed the Gmail follow-up draft for Alice Chen and held it for approval without claiming connector delivery.",
    }),
    {
      type: "connectorDispatchOccurred",
      turn: "draft-gmail-followup",
      channel: "gmail",
      expected: false,
      maxCount: 0,
    },
  ],
});
