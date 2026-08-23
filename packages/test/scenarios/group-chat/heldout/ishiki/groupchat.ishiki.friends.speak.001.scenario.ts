/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.friends.speak.001",
  title: "Held-out group timing: FRIENDS SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "joey",
  context: [
    {
      speaker: "chandler",
      text: "All right Rock, Paper, Scissors who has to tell the whore to leave! (Joey smirks.) What?",
    },
    {
      speaker: "ScenarioAgent",
      text: "I miss this.",
    },
  ],
  decisionTurn: {
    speaker: "chandler",
    text: "I don’t think we’ve actually done this before!",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_5turns_5073_turn2_targetjoey",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
