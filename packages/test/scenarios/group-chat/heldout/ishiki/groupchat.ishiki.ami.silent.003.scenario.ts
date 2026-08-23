/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.ami.silent.003",
  title: "Held-out group timing: AMI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "D",
  context: [
    {
      speaker: "A",
      text: "I think .",
    },
    {
      speaker: "ScenarioAgent",
      text: "Huh .",
    },
    {
      speaker: "A",
      text: "I don't know .",
    },
    {
      speaker: "A",
      text: "Otherwise it's just saying I'm the secretary",
    },
    {
      speaker: "A",
      text: "and I'm therefore I'm taking the minutes ,",
    },
    {
      speaker: "A",
      text: "s so just to go",
    },
    {
      speaker: "A",
      text: "um just real briefly to go over minutes from last meeting ,",
    },
    {
      speaker: "A",
      text: "uh , I will open them slowly , no ?",
    },
    {
      speaker: "A",
      text: "Wait for it , wait for it .",
    },
    {
      speaker: "ScenarioAgent",
      text: "Yeah",
    },
    {
      speaker: "ScenarioAgent",
      text: "that's not you .",
    },
    {
      speaker: "A",
      text: "No .",
    },
  ],
  decisionTurn: {
    speaker: "A",
    text: "That's how the",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "ES2009d_seq377_turn12_targetD",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
