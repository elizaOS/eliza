/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.friends.speak.002",
  title: "Held-out group timing: FRIENDS SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "rachel",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "I'm sorry, what did you just say? Did you just say hi? Oh my God, Ross, Ross, Ben just said 'Hi'.",
    },
  ],
  decisionTurn: {
    speaker: "ross",
    text: "Great, great, and I miss that too, I miss everything.",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_5turns_5739_turn1_targetrachel",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
