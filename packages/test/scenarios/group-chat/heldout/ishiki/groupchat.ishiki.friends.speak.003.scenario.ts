/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.friends.speak.003",
  title: "Held-out group timing: FRIENDS SPEAK",
  label: "speak",
  directlyAddressed: true,
  targetSpeaker: "ross",
  context: [
    {
      speaker: "chandler",
      text: "I spelled out boobies.",
    },
  ],
  decisionTurn: {
    speaker: "monica",
    text: "(comes up and starts looking through Ross’s cookie supply) Ross, but me down for another box of the mint treasures, okay. Where, where are the mint treasures?",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "test_5turns_845_turn1_targetross",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.friends.speak.003",
  title: "Held-out group timing: FRIENDS SPEAK",
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
