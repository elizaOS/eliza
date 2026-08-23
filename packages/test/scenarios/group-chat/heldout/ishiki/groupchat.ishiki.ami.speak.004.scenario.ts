/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.speak.004",
  title: "Held-out group timing: AMI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "D",
  context: [
    {
      speaker: "B",
      text: "I dunno .",
    },
    {
      speaker: "C",
      text: "I think that'd probably scare me .",
    },
  ],
  decisionTurn: {
    speaker: "B",
    text: "Would we put that on the inside or",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "ES2002c_inferred182_turn2_targetD",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
