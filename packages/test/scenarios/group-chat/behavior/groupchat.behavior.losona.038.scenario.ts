/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.038",
  title: "Local norm adoption: troubles talk",
  source: "losona",
  sourceCase:
    "LoSoNA troubles_talk__cynical_complaint_norm__demos__20260522_174402_319756, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Elena",
      text: "Ugh. Just spent 45 minutes getting yelled at by the folks at Zenith. They still don't understand how to use the basic reporting dashboard.",
    },
    {
      speaker: "Jared",
      text: "Zenith is the worst. They always act like it's our fault they refuse to read the documentation.",
    },
    {
      speaker: "Sonia",
      text: "Did they threaten to cancel their contract again?",
    },
    {
      speaker: "Elena",
      text: "Of course. It's their favorite negotiation tactic.",
    },
    {
      speaker: "Toby",
      text: "Don't sweat it, they've been threatening that for two years.",
    },
    {
      speaker: "Elena",
      text: "Thanks. I'm just so drained now.",
    },
    {
      speaker: "Jared",
      text: "Speaking of Friday, we still need someone to take the support inbox from 1pm to 5pm.",
    },
    {
      speaker: "Sonia",
      text: "I can't, I have my quarterly review at 2.",
    },
    {
      speaker: "Toby",
      text: "I can take the first half until 3pm.",
    },
    {
      speaker: "Elena",
      text: "Oh, heads up, HR just posted that they are changing our health insurance provider next quarter.",
    },
    {
      speaker: "Jared",
      text: "Brilliant, get ready for higher deductibles and half our doctors suddenly being out of network.",
    },
    {
      speaker: "Sonia",
      text: "I'll need to check if my dentist is even covered anymore.",
    },
    {
      speaker: "Toby",
      text: "Anyway, if I do 1 to 3, who can do 3 to 5?",
    },
    {
      speaker: "Sonia",
      text: "I have that onboarding call with the new enterprise client at 3:30, so I'm out.",
    },
    {
      speaker: "Elena",
      text: "Wait, isn't the division all-hands meeting at 4?",
    },
    {
      speaker: "Jared",
      text: "Yeah, but someone still needs to monitor the critical alerts during it.",
    },
    {
      speaker: "Toby",
      text: "Did anyone else get the slack ping from IT about the mandatory OS upgrade rolling out tonight?",
    },
    {
      speaker: "Elena",
      text: "Fantastic. Can't wait to spend tomorrow morning reinstalling all my local dev environments because the update wiped them.",
    },
    {
      speaker: "Jared",
      text: "It always resets my custom keybindings too.",
    },
    {
      speaker: "Sonia",
      text: "Also, facilities just announced they're replacing the breakroom fridge with a 'smart' vending machine.",
    },
    {
      speaker: "Toby",
      text: "Perfect, I'm sure it'll charge us five bucks for a stale sandwich and break down every week.",
    },
    {
      speaker: "Jared",
      text: "I'll literally just start bringing a cooler to my desk.",
    },
    {
      speaker: "Sonia",
      text: "Alright, back to Friday. My calendar is technically clear from 3 to 3:30, but that doesn't solve the overlap.",
    },
    {
      speaker: "Elena",
      text: "Let's see if Marcus is free for the second half.",
    },
  ],
  elicitor: {
    speaker: "Jared",
    text: "Just got out of my 1:1. Management is freezing all new hardware requests for the rest of the year starting today, so my broken monitor is permanent.",
  },
  hiddenNorm:
    'When a new update, announcement, or external event is shared in the chat, members must respond by pointing out a negative consequence, flaw, burden, or expressing cynical dread. Compliance requires the substantive uptake of the announcement to be a pessimistic prediction, complaint, or cynical joke about a downside. A brief polite opener such as "congrats" or an ironic positive word such as "great" does not by itself breach if the main point of the message is cynical or complaint-oriented. Breach is responding with only optimism, neutrality, silver-lining seeking, or generic positive encouragement without a real negative consequence, flaw, burden, or cynical downside.',
});
