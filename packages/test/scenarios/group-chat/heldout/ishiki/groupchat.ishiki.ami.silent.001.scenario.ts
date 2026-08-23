/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.silent.001",
  title: "Held-out group timing: AMI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "C",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "so",
    },
    {
      speaker: "ScenarioAgent",
      text: "red for power , um arrows for different volume ups and downs and channels ups and downs and what not .",
    },
    {
      speaker: "D",
      text: "Mm .",
    },
    {
      speaker: "ScenarioAgent",
      text: "And uh perhaps even adding in some stupid little jokes with the voice recognition idea",
    },
    {
      speaker: "ScenarioAgent",
      text: "like perh mm for instance my toastie maker that I got from my bank",
    },
    {
      speaker: "ScenarioAgent",
      text: "has jokes when it's ready .",
    },
    {
      speaker: "D",
      text: "Nice .",
    },
    {
      speaker: "A",
      text: "Great .",
    },
    {
      speaker: "ScenarioAgent",
      text: "And uh that is about it .",
    },
  ],
  decisionTurn: {
    speaker: "A",
    text: "Great , wonderful Ron , cool .",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "ES2009c_seq277_turn9_targetC",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
