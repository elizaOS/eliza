/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.friends.silent.003",
  title: "Held-out group timing: FRIENDS SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "chandler",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "Well, what’d you do?",
    },
  ],
  decisionTurn: {
    speaker: "joey",
    text: "I did it anyway.",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_8turns_6931_turn1_targetchandler",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
