/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.speak.001",
  title: "Held-out group timing: SPGI SPEAK",
  label: "speak",
  directlyAddressed: true,
  targetSpeaker: "36426",
  context: [
    {
      speaker: "16366",
      text: "These projects represent growing momentum in the region that will create meaningful benefits for customers and communities for years to come In summary despite challenging operating conditions in the third quarter we made important progress towards strengthening key cost recovery mechanisms as part of the constructive GRC settlement Our entire team is laser focused on execution for the remainder of the year Our long term growth plan is increasingly well established underpinned by investments to meet growing customer needs ensuring grid resilience and leading the clean energy transition Our recent regulatory progress and ongoing capital investment reinforces our confidence in our long term earnings growth rate of 5 to 7 in 2024 and beyond With that I'll turn it over to Joe who will walk you through our financial results Thank you",
    },
    {
      speaker: "ScenarioAgent",
      text: "Thank you Maria and good morning everyone I'll cover our Q3 results before providing updates on our rate case capital investments and liquidity and financing a structural going forward management of our cost I mean so we would expect to have the same structure in place These are not one time items to achieve benefits for the year but more structural items as we relate to changing the way we manage our costs and run our business going forward So we would expect that to continue",
    },
    {
      speaker: "16366",
      text: "Richard one of the things as you look at our external statements I think it's important that we acknowledge that there's a couple of things going on The first is you can see the amortization of deferrals from the ice storm wildfire events prior PCAM years and other things are increasing that O M line But so our ongoing wildfire prevention work all of the mitigation we do the interaction we do with the U S forest service and local entities really around vegetation management and others And through this rate case there were some really important mechanisms that were put in place That combined with what Joe was speaking of in terms of the ongoing alignment reduction in our costs quite frankly just driving efficiencies using technology better You can see we've had plant availability most recently as the 96 percentile rate and our first status rate was just 1 7 That was a huge contributor particularly to the third quarter",
    },
    {
      speaker: "15024",
      text: "sustaining itself here in the medium term I don't want to put words in your mouth",
    },
    {
      speaker: "16366",
      text: "Yes No no It's interesting We look at it as building blocks and I think there's really been a period of time of so much change and opportunity So first of all we are a state and a region that has benefited from in migration And while that has paused most recently we continue to see really strong like blocking and tackling economic growth across our service territory What we also are seeing is increased data centers and the continued digital expansion One of the things that's important about that is that many of those facilities are built but not yet built out And so the infrastructure is there and you'll see the capacity built out over the coming months and quarters And then finally the longer term and really significant opportunities comes in the manufacturing side of things And this is everyone",
    },
    {
      speaker: "ScenarioAgent",
      text: "I think I'm not sure I would do that math on the net power costs And specifically we're talking about 2024 here But I think the performance of what will fall to the bottom line is obviously our load recovery our return on the assets here as we build to '24 I mean the rate case overall and the net outcome that we have we're pretty satisfied that it was a really constructive dialogue And the case itself fits within our what I'll call our calculus to Maria's comments of our long term growth plan",
    },
    {
      speaker: "11244",
      text: "And then could you just expand a little on why load and demand mix was an issue for third quarter but what's just driving your confidence level for the fourth quarter I'm sorry if I missed that",
    },
    {
      speaker: "ScenarioAgent",
      text: "Yes So I think as it relates specifically to the third quarter right the mix shift was away from the residential commercial heading towards the larger And it's really due to 2 things that occur more the one that occurs more in the summer period and one overall One is energy efficiency We have a little more penetration on energy efficiency at that commercial and that residential level But also and more of the summer item there was rooftop solar penetration that was occurring at both that commercial and that residential level that was pushing down the overall load The customer growth",
    },
  ],
  decisionTurn: {
    speaker: "19639",
    text: "If you had this settlement on the PCAM in place just for that event not for the quarter but just for that event how would that have kind of played out And how would we think about the numbers Again it's more of a guesstimate by you guys but I'm just curious",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "39669_t8_target36426",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.speak.001",
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
