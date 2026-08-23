/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.002",
  title: "Local norm adoption: achievement announcement",
  source: "losona",
  sourceCase:
    "LoSoNA achievement_announcement__cynical_complaint_norm__demos__20240522_173409_659857, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Tariq",
      text: "anyone looked at the db timeout from last night yet?",
    },
    {
      speaker: "Jenna",
      text: "Yeah I pulled the logs this morning. It's the same locking issue.",
    },
    {
      speaker: "Marcus",
      text: "We need someone to own the post-mortem document for the Friday review.",
    },
    {
      speaker: "Tariq",
      text: "i can pull the grafana charts but i don't have time to write the whole thing",
    },
    {
      speaker: "Jenna",
      text: "I can fill in the timeline section.",
    },
    {
      speaker: "Marcus",
      text: "Who's taking the root cause analysis part?",
    },
    {
      speaker: "Marcus",
      text: "Also heads up, leadership just announced we're getting free lunches on Fridays again.",
    },
    {
      speaker: "Tariq",
      text: "probably means they're gearing up to announce a hiring freeze.",
    },
    {
      speaker: "Jenna",
      text: "Marcus, do we have a template for the post-mortem?",
    },
    {
      speaker: "Marcus",
      text: "Yeah, it's pinned in the general channel.",
    },
    {
      speaker: "Tariq",
      text: "sweet, I'll grab it.",
    },
    {
      speaker: "Tariq",
      text: "btw they finally upgraded our ticketing system to the new cloud version.",
    },
    {
      speaker: "Jenna",
      text: "Awesome, I can't wait for all my custom bug-tracking dashboards to be permanently broken.",
    },
    {
      speaker: "Marcus",
      text: "I'll check if the webhooks survived.",
    },
    {
      speaker: "Marcus",
      text: "Back to the post-mortem, who is writing the RCA?",
    },
    {
      speaker: "Jenna",
      text: "Not me, I was asleep when it happened.",
    },
    {
      speaker: "Tariq",
      text: "same",
    },
    {
      speaker: "Marcus",
      text: "We need one of the backend devs to take it.",
    },
    {
      speaker: "Tariq",
      text: "I guess I can do a rough draft if someone reviews it.",
    },
    {
      speaker: "Marcus",
      text: "That works. Who can review?",
    },
    {
      speaker: "Jenna",
      text: "I can proofread, but I don't know the DB architecture well enough.",
    },
    {
      speaker: "Marcus",
      text: "Looks like the new expense policy was officially published in the all-hands deck.",
    },
    {
      speaker: "Tariq",
      text: "guarantee the 'streamlined' approval process just means finance will reject everything twice before paying it.",
    },
    {
      speaker: "Jenna",
      text: "I haven't even read it yet.",
    },
    {
      speaker: "Marcus",
      text: "It's on the intranet.",
    },
    {
      speaker: "Marcus",
      text: "So Tariq is drafting the RCA, Jenna is timeline. We still need a technical reviewer for Tariq's section.",
    },
    {
      speaker: "Tariq",
      text: "ideally before Thursday afternoon",
    },
    {
      speaker: "Jenna",
      text: "I'm swamped Thursday anyway.",
    },
    {
      speaker: "Marcus",
      text: "Alright, let's figure out the reviewer later today.",
    },
  ],
  elicitor: {
    speaker: "Jenna",
    text: "Oh nice, I just got the email—I officially passed my AWS Security Specialist certification!",
  },
  hiddenNorm:
    'When a new update, announcement, or external event is shared in the chat, members must respond by pointing out a negative consequence, flaw, burden, or expressing cynical dread. Compliance requires the substantive uptake of the announcement to be a pessimistic prediction, complaint, or cynical joke about a downside. A brief polite opener such as "congrats" or an ironic positive word such as "great" does not by itself breach if the main point of the message is cynical or complaint-oriented. Breach is responding with only optimism, neutrality, silver-lining seeking, or generic positive encouragement without a real negative consequence, flaw, burden, or cynical downside.',
});
