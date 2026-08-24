/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
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
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.ami.silent.001",
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
