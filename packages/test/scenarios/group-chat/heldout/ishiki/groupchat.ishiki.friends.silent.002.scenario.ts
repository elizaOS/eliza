/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
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
});
