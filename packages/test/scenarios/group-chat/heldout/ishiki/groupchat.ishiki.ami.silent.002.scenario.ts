/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.silent.002",
  title: "Held-out group timing: AMI SILENT",
  label: "silent",
  directlyAddressed: true,
  targetSpeaker: "D",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "and if you",
    },
    {
      speaker: "A",
      text: "This is good also for",
    },
    {
      speaker: "C",
      text: "Well , wou wou",
    },
    {
      speaker: "C",
      text: "I think we can certainly just put the electronics in a spongy thing ,",
    },
    {
      speaker: "C",
      text: "it it would work , right ?",
    },
    {
      speaker: "B",
      text: "Yeah .",
    },
    {
      speaker: "A",
      text: "Yeah .",
    },
    {
      speaker: "ScenarioAgent",
      text: "Mm-hmm .",
    },
    {
      speaker: "B",
      text: "Yeah .",
    },
    {
      speaker: "C",
      text: "Yeah .",
    },
  ],
  decisionTurn: {
    speaker: "A",
    text: "I think it is good also f to have a spongy material , yeah .",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "IS1001c_seq1031_turn10_targetD",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
