/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.silent.003",
  title: "Held-out group timing: SPGI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "23159",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "Presenting on today's call are Robert Sanchez Chairman and Chief Executive Officer and John Diez Executive Vice President and Chief Financial Officer Additionally Tom Havens President of Fleet Management Solutions and Steve Sensing President of Supply Chain Solutions and Dedicated Transportation Solutions are on the call today and available for questions following the presentation At this time I'll turn the call over to Robert",
    },
    {
      speaker: "26926",
      text: "Good morning everyone and thanks for joining us I am very proud of our team for delivering another quarter of strong performance despite continued challenges in the freight market Our operating results continue to demonstrate that the transformative changes we've made to derisk our business model enhanced returns and free cash flow and drive long term profitable growth have significantly increased the earnings and return profile of the business versus prior cycles Results for the quarter were above our forecast reflecting better than expected performance in used vehicle sales lower truck maintenance costs and better performance in our supply chain automotive business I'll begin today's call by providing you with a strategic update John will then take you through our third quarter results",
    },
    {
      speaker: "32170",
      text: "We would like to welcome the team A team of about 1 000 employees will join Ryder here in the next few weeks and really excited about meeting them and getting them as part of Ryder",
    },
  ],
  decisionTurn: {
    speaker: "26926",
    text: "Yes Brian the only other thing I'd add to it is it is accretive to our results going into next year somewhat accretive And then from a margin standpoint I would say is in line with our supply chain margins longer term",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "34423_t3_target23159",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.silent.003",
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
