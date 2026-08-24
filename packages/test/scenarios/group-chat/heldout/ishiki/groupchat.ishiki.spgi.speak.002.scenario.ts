/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.speak.002",
  title: "Held-out group timing: SPGI SPEAK",
  label: "speak",
  directlyAddressed: false,
  targetSpeaker: "268",
  context: [
    {
      speaker: "36893",
      text: "But just kind of give us the lay of the land What exactly happened Was it a breach Was it not a breach some are calling it a compromise What exactly occurred And just why not give us some more insight into what was going on back in January",
    },
    {
      speaker: "33465",
      text: "Yes for sure So what happened was we had a sub processor it's called a sub processor It's like an outsourced support team that help us supplement our support of our Okta customers And in that support center there are about 40 support agents that take calls and do tasks for things like password resets and filing cases and looking at solutions for cases and things like that And that support center had a breach And they got the hackers got into that support center and got access to those computers and were able to view and control the computers And so the implications for Okta are that it's essentially the whatever a support person could do or support engineer could do the hackers could do on their behalf And so the blast radius of that is whether that's through direct customer interaction or whether that's through blog posts or whether that's through various other channels CSMs et cetera And that's the spirit It's like here's what we know Here's how it's evolving Here are the risks Here are the whole situational awareness and to help customers manage through all issues because we're we work with customers on security issues that they're having in their environment that Okta can help them solve And so this relationship where we work with customers on triage and through these things is something they value in us And when a situation like this happens it's no different They want to work with us to figure out the impact and how they can mitigate it and move forward",
    },
    {
      speaker: "36893",
      text: "And we saw a lot of those blog posts the communication you were putting out yesterday Is the way to think about it and like the customers understand that this is still evolving is case closed it all behind us Like where are we in that process",
    },
    {
      speaker: "33465",
      text: "Yes I think these are I mean you can imagine that we're very we have a whole team that is totally focused on security So the team is it's continuous They're always looking at all issues and threats and opportunities So",
    },
    {
      speaker: "36893",
      text: "And when we kind of look out past this initial news release obviously you guys aren't updating the guidance But how should investors think just about the potential impact if at all the sales cycles and maybe just the future growth trajectory over the next 12 months",
    },
    {
      speaker: "33465",
      text: "We're very confident in the growth trajectory I think we've built the company with this partnership with customers for a long time And I think that customers are if you're running the business today it's one of the reasons we're so successful is because there's so much technology and we do such a good job helping them capture the value of that technology And part of that is a collaboration through new initiatives through potential issues And I think they'll see that we're really a strong partner in that regard",
    },
    {
      speaker: "36893",
      text: "And kind of just doubling down on that last comment we have spoken some customers since the news dropped like what is your 1 initiative kind of to reinstill confidence in your customer base and future potential customers that they should still be trusting Okta with their identity needs going forward",
    },
  ],
  decisionTurn: {
    speaker: "33465",
    text: "Well it's I think it's always been our 1 continuous ongoing priority It's customer success and trust and confidence in Okta It's really important to our brand and we've built a very very strong brand around this and I expect that to continue",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "7692_t7_target268",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.speak.002",
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
