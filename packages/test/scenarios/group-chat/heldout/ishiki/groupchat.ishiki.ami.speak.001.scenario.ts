/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.ami.speak.001",
  title: "Held-out group timing: AMI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "C",
  context: [
    {
      speaker: "B",
      text: "so that you don't have to have a lot of buttons for uh anything .",
    },
    {
      speaker: "B",
      text: "And it should be a user friendly , clear buttons , and not too much .",
    },
    {
      speaker: "B",
      text: "And that is my presentation .",
    },
    {
      speaker: "A",
      text: "Okay ,",
    },
    {
      speaker: "ScenarioAgent",
      text: "Okay .",
    },
    {
      speaker: "A",
      text: "thank you .",
    },
    {
      speaker: "D",
      text: "'Kay . Check .",
    },
    {
      speaker: "B",
      text: "You must still have it open .",
    },
    {
      speaker: "D",
      text: "Kijke",
    },
    {
      speaker: "D",
      text: "'Kay , so .",
    },
    {
      speaker: "D",
      text: "We're going to j discuss the functional requirements of the remote ,",
    },
    {
      speaker: "ScenarioAgent",
      text: "Hmm .",
    },
    {
      speaker: "D",
      text: "'Kay .",
    },
    {
      speaker: "D",
      text: "Findings .",
    },
    {
      speaker: "D",
      text: "Fifty percent of the users lose their remote often .",
    },
    {
      speaker: "D",
      text: "So we don't have to make it very small , like uh like a mobile phone or something ,",
    },
    {
      speaker: "B",
      text: "Yeah .",
    },
    {
      speaker: "D",
      text: "but some somewhat bi bigger than small ,",
    },
    {
      speaker: "D",
      text: "so you don't lose it that much anymore .",
    },
  ],
  decisionTurn: {
    speaker: "D",
    text: "Seventy five percent of the users also find it ugly ,",
  },
  sourceDomain: "ami",
  sourceDecisionPointId: "TS3005b_seq2409_turn19_targetC",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.ami.speak.001",
  title: "Held-out group timing: AMI SPEAK",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.decisionTurn,
      assertResponse(text: string) {
        const responseLength = text.trim().length;
        if (responseLength === 0) {
          return "held-out label is SPEAK, but the agent produced no reply";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "heldout-timing:speak",
      minimumScore: 0.7,
      rubric:
        "The assistant occupies one participant's seat in a group conversation. The observed target participant took the next turn. Score whether the assistant makes a concise, relevant contribution that fits the conversation and responds to the delivered turn.",
    },
  ],
});
