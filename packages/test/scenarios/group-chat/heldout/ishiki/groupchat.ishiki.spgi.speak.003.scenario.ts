/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.speak.003",
  title: "Held-out group timing: SPGI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "-1",
  context: [
    {
      speaker: "32965",
      text: "Those are starting to clear up and we'll see a half next year to that plus higher commercial deliveries as well as the continued aftermarket comeback It kind of supports that going from where we are today and about that 17 into the 5 range over",
    },
    {
      speaker: "ScenarioAgent",
      text: "Great And then my next question was going to be on the supply chain headwind So where has that been more pronounced for Crane Aerospace and Electronics this year Which supply chain challenges are starting to ease and which may be still getting harder",
    },
    {
      speaker: "32965",
      text: "No in all it's been a really unique year in that It really started the year with like some discrete more complex electronic component challenges kind of coming out of the whole semiconductor before That's kind of transition for us into like more raw materials castings team parts which is headed some do with available raw material but then kind of transition to a labor crunch at our suppliers",
    },
  ],
  decisionTurn: {
    speaker: "36693",
    text: "Yes I mean I don't we feel pretty strongly that this is going to continue it's not going to improve We feel pretty confident in that I wouldn't say that that's being overly conservative If I look out across the landscape of all of Crane right So in aerospace we feel like it's going to continue in defense Aero and defense is going to continue for a while There is some improvement that we're seeing in some of the other aspects of our business We see a little bit of improvement in our process flow technologies business for example maybe even a little bit in payment but it's still a lot of electronic component hiccups from time to time that we have to deal with But I would say I agree with J 100 this is like second half of next year towards the end of next year I would say for all of the A E industry",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "21524_t3_target-1",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.speak.003",
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
