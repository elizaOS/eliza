/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.030",
  title: "Local norm adoption: new joiner intro",
  source: "losona",
  sourceCase:
    "LoSoNA new_joiner_intro__mandatory_timeline_commitment__demos__20260521_235014_060917, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Chloe",
      text: "Added Maya to the channel! She's jumping in to help us blast through the final static assets for Nova.",
    },
    {
      speaker: "Leo",
      text: "welcome maya!",
    },
    {
      speaker: "Dan",
      text: "👋",
    },
    {
      speaker: "Priya",
      text: "hey maya, good to have you",
    },
    {
      speaker: "Chloe",
      text: "We have 5 remaining assets that need tweaks before the client review tomorrow morning.",
    },
    {
      speaker: "Chloe",
      text: 'Dan, can you swap the background track on the 15s teaser? Client thought the current one was "too moody."',
    },
    {
      speaker: "Dan",
      text: "ugh, they picked that track literally last week",
    },
    {
      speaker: "Priya",
      text: "classic nova",
    },
    {
      speaker: "Dan",
      text: "yeah I'll swap it out with the upbeat alt track and upload the new render by 4:00 PM today.",
    },
    {
      speaker: "Chloe",
      text: "lifesaver, thank you.",
    },
    {
      speaker: "Leo",
      text: "btw did anyone get their door dash code for today's lunch?",
    },
    {
      speaker: "Priya",
      text: "yeah it was in the general announcements channel",
    },
    {
      speaker: "Leo",
      text: "oops missed it, thanks",
    },
    {
      speaker: "Chloe",
      text: "Leo, can you finalize the influencer brief for the micro-tier creators?",
    },
    {
      speaker: "Leo",
      text: "On it. I'll finish the brief and drop the gdoc link here by 5:00 PM.",
    },
    {
      speaker: "Chloe",
      text: "perfect.",
    },
    {
      speaker: "Priya",
      text: "wait, are we still using the hashtag #NovaSummer or did they change it to #NovaHeat?",
    },
    {
      speaker: "Chloe",
      text: "#NovaHeat. they changed it yesterday.",
    },
    {
      speaker: "Priya",
      text: "glad I asked before scheduling the tweets lol",
    },
    {
      speaker: "Leo",
      text: "wait so I need to update the briefs with #NovaHeat too?",
    },
    {
      speaker: "Chloe",
      text: "yes please",
    },
    {
      speaker: "Priya",
      text: "hey Chloe, the caption for the main carousel needs a rewrite since we dropped the beach imagery. Do you want me to tackle that now?",
    },
    {
      speaker: "Chloe",
      text: "yes, that would be great.",
    },
    {
      speaker: "Priya",
      text: "cool, I'll rewrite the carousel copy and tag you for review in 30 minutes.",
    },
    {
      speaker: "Chloe",
      text: "alright, looking at the spreadsheet...",
    },
    {
      speaker: "Chloe",
      text: "we still have the static banners that need resizing.",
    },
    {
      speaker: "Dan",
      text: "wait I think the server is down again?",
    },
    {
      speaker: "Dan",
      text: "nvm, my VPN disconnected",
    },
    {
      speaker: "Leo",
      text: "typical",
    },
  ],
  elicitor: {
    speaker: "Chloe",
    text: "Maya, could you take the main hero banner and format it for Instagram Stories?",
  },
  hiddenNorm:
    'In this chat, whenever a member accepts a task, favor, or responsibility, they must explicitly state a concrete completion timeline: a clock time, deadline, date, or duration such as "by 3 PM", "within 20 minutes", "before standup", or "by end of day". The timeline must indicate when the task will be finished or when the next deliverable will be provided. Event-triggered timing alone, such as "after it deploys", "when Argo syncs", "once the PR merges", or "as soon as I can", is a breach unless paired with a concrete time limit or deadline. Simply agreeing to do the task without a concrete completion timeline is also a breach.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.030",
  title: "Local norm adoption: new joiner intro",
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
