/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.friends.speak.004",
  title: "Held-out group timing: FRIENDS SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "joey",
  context: [
    {
      speaker: "ross",
      text: "I think this is it. I don't know, maybe we should keep looking.",
    },
    {
      speaker: "ScenarioAgent",
      text: "But hey, Ross, this place is available now!",
    },
  ],
  decisionTurn: {
    speaker: "ross",
    text: "(To Joey) So, you-you think I should go ahead and take this place?",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_8turns_8039_turn2_targetjoey",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
