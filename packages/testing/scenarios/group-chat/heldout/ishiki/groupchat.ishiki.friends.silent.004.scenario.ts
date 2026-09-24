/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.friends.silent.004",
  title: "Held-out group timing: FRIENDS SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "ross",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "Oh, all right. (Joey flips the coin.) Tails! (The coin bounces off of the landing above them and falls to the ground.) Can you-can you see what it is?",
    },
    {
      speaker: "joey",
      text: "What? No! No Ross! No-no! Stop! I’m not jumping! Okay, look I have an audition tomorrow and I can’t go if I break my leg.",
    },
    {
      speaker: "ScenarioAgent",
      text: "Well I’m jumping! I have a son! Okay? He won’t have a father if-if I die!",
    },
  ],
  decisionTurn: {
    speaker: "joey",
    text: "Well all right so, it looks like we’re even!",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_5turns_9986_turn3_targetross",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.friends.silent.004",
  title: "Held-out group timing: FRIENDS SILENT",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.decisionTurn,
      assertResponse(text: string) {
        const responseLength = text.trim().length;
        if (responseLength > 0) {
          return `held-out label is SILENT; expected no agent response, got ${responseLength} characters`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "heldout-timing:silent",
      minimumScore: 0.7,
      rubric:
        "The assistant occupies one participant's seat in a group conversation. The observed target participant did not take the next turn. Score 1.0 only for literal silence and 0.0 for any reaction or interjection.",
    },
  ],
});
