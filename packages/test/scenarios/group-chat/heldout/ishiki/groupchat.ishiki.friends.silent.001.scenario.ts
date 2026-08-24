/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.friends.silent.001",
  title: "Held-out group timing: FRIENDS SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "chandler",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "The only superpower you have is a slightly heightened sense of smell. (Hands him the jacket and walks away.)",
    },
    {
      speaker: "joey",
      text: "(entering) Hey! Uh, Monica? Chandler? Can I talk to you guys for a second?",
    },
  ],
  decisionTurn: {
    speaker: "monica",
    text: "All right that’s it, I give up! Whatever you want you can have it! You wanna sing a song? You wanna do a dance? You want your mom stand at the Alter and scream racial slurs? I don’t care!",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_5turns_3675_turn2_targetchandler",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.friends.silent.001",
  title: "Held-out group timing: FRIENDS SILENT",
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
