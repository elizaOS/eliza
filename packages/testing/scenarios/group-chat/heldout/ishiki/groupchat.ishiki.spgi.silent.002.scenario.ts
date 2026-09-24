/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.silent.002",
  title: "Held-out group timing: SPGI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "23303",
  context: [
    {
      speaker: "12379",
      text: "And then just super quick on that because you did mention it recently Wondering if it's now a higher priority to either come up with a plan for the rosin side of the Crossett asset base whether that's an alternative feedstock or just minimizing any stranded costs associated with that",
    },
    {
      speaker: "7894",
      text: "Well the beauty of those raw materials is they don't generate rosin",
    },
    {
      speaker: "41225",
      text: "And we are obviously in place to serve those vehicles with the products that they want",
    },
    {
      speaker: "-1",
      text: "And then how should we think about the puts and takes for free cash flow for the rest of the year given kind of spiking CTO but then volumes are off",
    },
    {
      speaker: "ScenarioAgent",
      text: "Yes So we see a pretty normal pattern for free cash flow this year Again free cash flow is typically negative in Q1 excluding the COVID period So really no surprise there And we look forward we held the guidance I'm sure you noted on free cash flow and debt reduction and feel good about that And sometimes we get the question well what about if the recession does play out things continue to slow down how does that impact free cash flow And as you know in this business actually if we really got into recessionary scenario free cash flow improves because then you're not building inventory you're not building accounts receivable So we are holding steady on that free cash flow projection and feel good about it",
    },
    {
      speaker: "32370",
      text: "we've kind of seen growth of about 25 of the business up to about 1 3 of the business now",
    },
    {
      speaker: "33943",
      text: "I'm sorry 25 what was the last thing you said",
    },
    {
      speaker: "ScenarioAgent",
      text: "25 to 30",
    },
    {
      speaker: "32370",
      text: "Around about 30",
    },
    {
      speaker: "33943",
      text: "So is it fair to say that a lot of the growth or a lot of the performance in that business is just coming from auto restock cycle Is that kind of accurate",
    },
  ],
  decisionTurn: {
    speaker: "7894",
    text: "I don't know if I agree with that because a lot of what he's doing is new product application right So one of the things that the picture that was on the slide is a protective film that is pretty popular in Asia in particular in China right It's an aftermarket application that because their roads are a little tougher than in the Western Europe and in the United States a lot of the people will put this film on their car because it helps avoid the dings and the dashes that you would get from rocks or other things that are on the road right That's really a technology or product development as opposed to just being tied to right They're also there's a lot of work being done where the applications were tied to electric vehicles in terms of these basically bounce choice which are think of them as sort of rubber shock pads that the batteries sit on",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "26780_t13_target23303",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.silent.002",
  title: "Held-out group timing: SPGI SILENT",
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
