/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.speak.004",
  title: "Held-out group timing: SPGI SPEAK",
  label: "speak",
  directlyAddressed: true,
  targetSpeaker: "41003",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "It kind of depends on market conditions and point in time And so I can't give you a specific answer for this is the lever we're going to pull for those particular expansions But that will be a question that will come more to the forefront in the coming months",
    },
    {
      speaker: "19778",
      text: "Understood And it seems like you do have many levers and optionality around that For my second question I was wondering if you could discuss what prices you're currently seeing for rigs right now And as you consider purchasing rigs earlier than the infrastructure is actually available to take advantage of the current low prices",
    },
    {
      speaker: "ScenarioAgent",
      text: "Yes So it's a constantly shifting target So it moves day by day I think the thing to keep in mind is and candidly I haven't seen a price run since this Bitcoin rally began with the news this week but hash price is still depressed right We've seen a huge growth in network rates So the most recent prices I've seen I've seen quotes in the low double digit dollars per terahash so kind of 13 but that can move day by day and it depends on how many you order at a clip I think it's fair to say that but it sort of ignores the hash price element of things right Because if we the problem with that is what if network cash rate goes to 1 000 exahash or something like that like you have to sort of think of both of those things at the same time if it makes sense",
    },
  ],
  decisionTurn: {
    speaker: "-1",
    text: "No it does It's a fascinating problem to solve So we'll be watching there I guess if I could sneak one more question in Very impressive price energy price per Bitcoin numbers you guys posted just like the lowest I've seen among any of the Bitcoin miners so that's great and hats off to you for that My question how do you think about kind of the unit economics below the energy line And what are you driving the business to there And I don't know if it's overhead for you what's the right way for investors to think about that too",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "46378_t3_target41003",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.speak.004",
  title: "Held-out group timing: SPGI SPEAK",
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
