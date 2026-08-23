/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.speak.002",
  title: "Held-out group timing: AMI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "C",
  context: [
    {
      speaker: "D",
      text: "I dunno .",
    },
  ],
  decisionTurn: {
    speaker: "A",
    text: "And you know , you have the finger here , with the buttons ?",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "IS1003d_seq1291_turn1_targetC",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
