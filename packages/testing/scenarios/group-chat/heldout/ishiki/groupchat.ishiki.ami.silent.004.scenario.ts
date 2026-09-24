/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
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
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.ami.silent.004",
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
