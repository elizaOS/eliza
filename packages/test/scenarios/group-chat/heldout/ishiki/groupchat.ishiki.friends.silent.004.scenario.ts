/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
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
});
