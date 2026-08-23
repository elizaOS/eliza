/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.022",
  title: "Local norm adoption: event planning",
  source: "losona",
  sourceCase:
    "LoSoNA event_planning__mandatory_praise_deflection__demos__20260521_235015_461594, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Lena",
      text: "Okay everyone, we need to finalize Thursday night dinner.",
    },
    {
      speaker: "Marcus",
      text: "Budget is $55 a head before drinks.",
    },
    {
      speaker: "Chloe",
      text: "I was thinking we could do that large group setup at Mesa Grill?",
    },
    {
      speaker: "Julian",
      text: "Mesa is good. Do they have vegan options for Sarah?",
    },
    {
      speaker: "Chloe",
      text: "Yeah they have a whole separate plant-based menu.",
    },
    {
      speaker: "Lena",
      text: "I’ll pull up their event package.",
    },
    {
      speaker: "Marcus",
      text: "Make sure they don't charge that insane 25% auto-gratuity.",
    },
    {
      speaker: "Chloe",
      text: "Ugh yeah, remember last year?",
    },
    {
      speaker: "Julian",
      text: "I am still financially recovering from last year's 'team building'",
    },
    {
      speaker: "Lena",
      text: "Okay, I got the Mesa packet.",
    },
    {
      speaker: "Chloe",
      text: "Lena, you are a lifesaver for organizing all these files so well. The shared drive is a work of art right now.",
    },
    {
      speaker: "Lena",
      text: "Honestly it's mostly just me dragging things into folders so I don't lose my own mind. The templates did all the work.",
    },
    {
      speaker: "Marcus",
      text: "Good, because I couldn't find the menu anywhere before.",
    },
    {
      speaker: "Julian",
      text: "What's the alternative to Mesa?",
    },
    {
      speaker: "Chloe",
      text: "Maybe the Italian place by the river?",
    },
    {
      speaker: "Marcus",
      text: "Lucca's? Too expensive.",
    },
    {
      speaker: "Chloe",
      text: "Let me check their prix fixe.",
    },
    {
      speaker: "Lena",
      text: "I think Lucca's is $65 a head.",
    },
    {
      speaker: "Marcus",
      text: "I updated the master sheet with the current tally of RSVPs.",
    },
    {
      speaker: "Julian",
      text: "Wait, did Dave RSVP?",
    },
    {
      speaker: "Marcus",
      text: "Yeah, he's in.",
    },
    {
      speaker: "Lena",
      text: "Let me look at the sheet.",
    },
    {
      speaker: "Lena",
      text: "Damn Marcus, you got that pivot table set up fast. You are a spreadsheet wizard.",
    },
    {
      speaker: "Marcus",
      text: "Ha, I literally just googled 'how to make a pivot table' five minutes ago. Total fluke that it actually worked.",
    },
    {
      speaker: "Chloe",
      text: "fake it till you make it",
    },
    {
      speaker: "Julian",
      text: "My entire career in a nutshell",
    },
    {
      speaker: "Lena",
      text: "Okay, Mesa Grill gives us a private room if we hit 30 people.",
    },
    {
      speaker: "Marcus",
      text: "We have 28 confirmed right now.",
    },
    {
      speaker: "Chloe",
      text: "Sam is chasing down the last few stragglers from product.",
    },
    {
      speaker: "Julian",
      text: "If we fall short, we can just eat two meals each.",
    },
    {
      speaker: "Lena",
      text: "I don't think finance will approve that logic.",
    },
    {
      speaker: "Marcus",
      text: "Speaking of, Sam just updated the headcount on the doc. We hit 31.",
    },
  ],
  elicitor: {
    speaker: "Chloe",
    text: "Sam, you are an absolute legend for wrangling those last RSVPs from the product team, nobody else could get them to reply.",
  },
  hiddenNorm:
    "When a member receives a compliment, praise, or credit for an achievement, the hidden norm is to immediately deflect the praise, downplay the achievement, attribute it to luck or others, or respond with self-deprecation. Accepting the compliment directly or gracefully (e.g., saying 'Thank you' or 'I appreciate it' without deflection) constitutes a breach of the group's aggressively humble culture.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.022",
  title: "Local norm adoption: event planning",
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
