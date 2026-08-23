/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.silent.004",
  title: "Held-out group timing: AMI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "A",
  context: [
    {
      speaker: "B",
      text: "In fact on a flat place",
    },
    {
      speaker: "C",
      text: "You can just",
    },
    {
      speaker: "B",
      text: "You can",
    },
  ],
  decisionTurn: {
    speaker: "D",
    text: "Yeah but then uh when you turn turn it",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "IS1003d_seq1375_turn3_targetA",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
