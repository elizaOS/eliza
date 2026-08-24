/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.019",
  title: "Local norm adoption: conflict escalation",
  source: "losona",
  sourceCase:
    "LoSoNA conflict_escalation__mandatory_silver_lining_norm__demos__20260522_173409_419593, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Sara",
      text: "Okay team, we need a final call on the beta launch. Do we push it to the 14th or do we cut the custom reporting dashboard entirely?",
    },
    {
      speaker: "Marcus",
      text: "We absolutely cannot cut reporting. It's the main feature the client advisory board asked for.",
    },
    {
      speaker: "Julian",
      text: "Have you seen the state of the API? It's nowhere near ready for live traffic.",
    },
    {
      speaker: "Marcus",
      text: "I thought the reporting endpoints were finalized last week?",
    },
    {
      speaker: "Julian",
      text: "The data team deployed a schema update on Friday, so all the queries are broken.",
    },
    {
      speaker: "Elena",
      text: "Yeah, and speaking of that, the new test environment wiped all my mock data overnight.",
    },
    {
      speaker: "Sara",
      text: "Ugh, well at least it happened now instead of during the load test! Gives us a chance to script the data generation properly.",
    },
    {
      speaker: "Elena",
      text: "True, I'll write a python script for it this afternoon.",
    },
    {
      speaker: "Marcus",
      text: "Back to the launch... if we delay to the 14th, does that give us enough time to fix the queries?",
    },
    {
      speaker: "Julian",
      text: "Barely. And I'd have to rewrite the auth middleware to support the new schema.",
    },
    {
      speaker: "Sara",
      text: "We really need to avoid delaying. Marketing has already drafted the press release.",
    },
    {
      speaker: "Marcus",
      text: "I spent three days refining those dashboard UI animations and now we're just going to scrap them to save a week?",
    },
    {
      speaker: "Julian",
      text: "Hey, look on the bright side, we can reuse those exact CSS modules for the admin panel next sprint.",
    },
    {
      speaker: "Marcus",
      text: "That's not the point. A beta without reporting is just a reskin. It's useless to the users.",
    },
    {
      speaker: "Julian",
      text: "And a beta that crashes every five minutes is useful?",
    },
    {
      speaker: "Marcus",
      text: "You're exaggerating. We just need to focus and get it done. It's not impossible.",
    },
    {
      speaker: "Julian",
      text: 'Oh, "just focus"? Thanks Marcus, I\'ll just type faster. Problem solved.',
    },
    {
      speaker: "Sara",
      text: "Guys, let's keep it constructive. Marketing just pinged me again, they are so furious about the potential delay.",
    },
    {
      speaker: "Elena",
      text: "Well, on the plus side, it means they actually care about our release! Better than launching to crickets.",
    },
    {
      speaker: "Sara",
      text: "Hah, fair point Elena.",
    },
    {
      speaker: "Marcus",
      text: "Julian, what if we just mocked the reporting data for the beta?",
    },
    {
      speaker: "Julian",
      text: "It's a live beta. They'd see everyone else's data.",
    },
    {
      speaker: "Marcus",
      text: "Then scope it down to their own tenant id! It's one parameter.",
    },
    {
      speaker: "Julian",
      text: "That requires rewriting the entire data access layer. You have no idea how the backend works.",
    },
    {
      speaker: "Marcus",
      text: "I feel like you're just looking for reasons to kill the feature because you don't want to deal with it.",
    },
    {
      speaker: "Julian",
      text: "Are you kidding me right now?",
    },
  ],
  elicitor: {
    speaker: "Julian",
    text: "Great, and to top it off, the staging server just completely locked up. I've lost the last hour of config changes I was testing.",
  },
  hiddenNorm:
    "When a group member shares a complaint, minor failure, or piece of bad news, responses must include a 'silver lining' or positive reframe of that same negative event. Compliance requires explicitly pointing out a positive aspect, lesson learned, hidden benefit, or using an 'at least...', 'bright side', or 'good news is...' framing. Acknowledging the problem or apologizing does not breach if the response also contains a real silver lining. Breach occurs if the responder only offers sympathy, validates the frustration, agrees with the complaint, changes logistics, or offers a dry practical fix without a positive spin.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.019",
  title: "Local norm adoption: conflict escalation",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.messageTurn,
      assertResponse(text: string) {
        if (text.trim().length === 0) {
          return "the elicitor requires a group-chat reply that demonstrates the inferred norm";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "local-norm-adoption",
      minimumScore: 0.8,
      rubric:
        `Judge only the subject agent's reply to the final elicitor. The group's hidden local norm is: ${config.hiddenNorm}` +
        " The target norm must be inferred only from peer demonstrations in the visible transcript. Score 1.0 only if the reply follows the functional norm naturally in the current context. Mere discussion or naming of the norm does not count. Score 0.0 if it violates the norm or responds as a generic assistant instead of a group member.",
    },
  ],
});
