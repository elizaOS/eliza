/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.friends.silent.002",
  title: "Held-out group timing: FRIENDS SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "rachel",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "(taking a bite) Oh my God! That is so good!",
    },
    {
      speaker: "chandler",
      text: "I’m full, and yet I know if I stop eating this, I’ll regret it.",
    },
    {
      speaker: "ScenarioAgent",
      text: "Oh it’s umm, it’s tofu cake. Do you want some? (He makes a disgusted noise and heads for his room, Chandler follows him in.)",
    },
  ],
  decisionTurn: {
    speaker: "chandler",
    text: "What are you doing tonight?",
  },
  sourceDomain: "friends",
  sourceDecisionPointId: "train_5turns_12048_turn3_targetrachel",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.friends.silent.002",
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
