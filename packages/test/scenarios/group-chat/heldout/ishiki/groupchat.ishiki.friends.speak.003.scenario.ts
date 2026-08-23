/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.friends.speak.003",
  title: "Held-out group timing: FRIENDS SPEAK",
  label: "speak",
  directlyAddressed: true,
  targetSpeaker: "ross",
  context: [
    {
      speaker: "chandler",
      text: "I spelled out boobies.",
    },
  ],
  decisionTurn: {
    speaker: "monica",
    text: "(comes up and starts looking through Ross’s cookie supply) Ross, but me down for another box of the mint treasures, okay. Where, where are the mint treasures?",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "test_5turns_845_turn1_targetross",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
