/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.speak.003",
  title: "Held-out group timing: AMI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "A",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "Oops .",
    },
    {
      speaker: "C",
      text: "Fancy .",
    },
  ],
  decisionTurn: {
    speaker: "D",
    text: "Now we're",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "IS1006d_inferred523_turn2_targetA",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
