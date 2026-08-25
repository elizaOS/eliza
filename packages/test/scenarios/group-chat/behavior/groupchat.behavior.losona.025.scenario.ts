/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.025",
  title: "Local norm adoption: forwarded screenshot",
  source: "losona",
  sourceCase:
    "LoSoNA forwarded_screenshot__mandatory_praise_deflection__demos__20260521_232944_904269, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Julian",
      text: '[Screenshot: "Need 3 new ad variants by tomorrow morning. I know the team can pull it off! -Greg"] i am actually going to walk into the ocean.',
    },
    {
      speaker: "Tyler",
      text: "wait is that from the apex slack channel?",
    },
    {
      speaker: "Julian",
      text: "no he just emailed it directly to me. at 4pm. on a thursday.",
    },
    {
      speaker: "Rebecca",
      text: "Classic Greg. Don't reply yet.",
    },
    {
      speaker: "Julian",
      text: "trust me i haven't. we need a unified front here.",
    },
    {
      speaker: "Nina",
      text: "we literally don't have the hours left in the retainer for this month.",
    },
    {
      speaker: "Tyler",
      text: "i mean... i can probably slap some copy together tonight if we absolutely have to cave",
    },
    {
      speaker: "Rebecca",
      text: "Absolutely not. The copy you wrote for their winter campaign was genius, we aren't wasting your talent on a rushed friday drop.",
    },
    {
      speaker: "Tyler",
      text: "lol please, i just spammed a rhyming dictionary and prayed nobody noticed it made no sense.",
    },
    {
      speaker: "Nina",
      text: "let's just tell him it's out of scope and offer monday EOD.",
    },
    {
      speaker: "Rebecca",
      text: "We need to word it carefully. Nina, how did you phrase the pushback last month when he wanted the video re-edited?",
    },
    {
      speaker: "Julian",
      text: "oh yeah, Nina's email for that was perfectly polite but firm. absolute masterclass in client management.",
    },
    {
      speaker: "Nina",
      text: "i literally just asked chatgpt to make me sound professional and copy-pasted it, my brain was completely turned off.",
    },
    {
      speaker: "Rebecca",
      text: "Well it worked. Let's draft something similar.",
    },
    {
      speaker: "Julian",
      text: "okay but who is going to be the one to actually send it to him? he's already annoyed with me",
    },
    {
      speaker: "Tyler",
      text: "not it",
    },
    {
      speaker: "Nina",
      text: "i can't, i have the Q3 kickoff in ten minutes",
    },
    {
      speaker: "Julian",
      text: "hold on, greg just sent another message in my DMs.",
    },
    {
      speaker: "Julian",
      text: '[Screenshot: "Make sure Sam presents them. Sam\'s pitch on Tuesday was an absolute home run."]',
    },
  ],
  elicitor: {
    speaker: "Rebecca",
    text: 'Wow Sam, a "home run" from Greg? You must have completely crushed that Tuesday pitch!',
  },
  hiddenNorm:
    "When a member receives a compliment, praise, or credit for an achievement, the hidden norm is to immediately deflect the praise, downplay the achievement, attribute it to luck or others, or respond with self-deprecation. Accepting the compliment directly or gracefully (e.g., saying 'Thank you' or 'I appreciate it' without deflection) constitutes a breach of the group's aggressively humble culture.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.025",
  title: "Local norm adoption: forwarded screenshot",
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
