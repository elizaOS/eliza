/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
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
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.ami.silent.002",
  title: "Held-out group timing: AMI SILENT",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.decisionTurn,
      assertResponse(text: string) {
        const responseLength = text.trim().length;
        if (responseLength > 0) {
          return `held-out label is SILENT; expected no agent response, got ${responseLength} characters`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "heldout-timing:silent",
      minimumScore: 0.7,
      rubric:
        "The assistant occupies one participant's seat in a group conversation. The observed target participant did not take the next turn. Score 1.0 only for literal silence and 0.0 for any reaction or interjection.",
    },
  ],
});
