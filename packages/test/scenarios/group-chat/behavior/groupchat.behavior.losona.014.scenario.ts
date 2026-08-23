/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.014",
  title: "Local norm adoption: birthday or anniversary ritual",
  source: "losona",
  sourceCase:
    "LoSoNA birthday_or_anniversary_ritual__mandatory_ironic_enthusiasm_norm__demos__20260521_233314_150908, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Toby",
      text: "Happy 5th anniversary to our fearless leader @Gemma 🎉🎉🎉 Half a decade of herding us cats!",
    },
    {
      speaker: "Arjun",
      text: "Happy anniversary Gemma!! 🎂",
    },
    {
      speaker: "Chloe",
      text: "Omg 5 years! Happy anniversary!! Hope you get a nap today lol",
    },
    {
      speaker: "Gemma",
      text: "Thanks guys 😭 I'm officially old.",
    },
    {
      speaker: "Toby",
      text: "Wait so we still need to lock in lunch for today's double rehearsal to celebrate.",
    },
    {
      speaker: "Toby",
      text: "Are we doing the Thai place or the diner?",
    },
    {
      speaker: "Arjun",
      text: "Thai gets my vote. I need those peanut noodles.",
    },
    {
      speaker: "Chloe",
      text: "I'm good with Thai!",
    },
    {
      speaker: "Arjun",
      text: "ugh wait. Just checked their site. They're closed for plumbing issues.",
    },
    {
      speaker: "Chloe",
      text: "Oh fantastic! I was really hoping we'd have to scramble for a new plan at the last second.",
    },
    {
      speaker: "Gemma",
      text: "Okay diner it is then.",
    },
    {
      speaker: "Toby",
      text: "Do they still have those giant milkshakes?",
    },
    {
      speaker: "Arjun",
      text: "Yeah but you have to pick them up, they don't deliver to the theater anymore.",
    },
    {
      speaker: "Gemma",
      text: "I can drive over at 1.",
    },
    {
      speaker: "Toby",
      text: "I'll come with to carry the drinks.",
    },
    {
      speaker: "Chloe",
      text: "btw I just went into the props closet and someone spilled glitter glue all over the fake swords.",
    },
    {
      speaker: "Gemma",
      text: "Oh wonderful! Peeling dried glue off plastic for two hours is exactly how I wanted to spend my anniversary.",
    },
    {
      speaker: "Toby",
      text: "Lmao",
    },
    {
      speaker: "Arjun",
      text: "Anyway back to the diner. Anyone want fries for the table?",
    },
    {
      speaker: "Chloe",
      text: "Yes please.",
    },
    {
      speaker: "Toby",
      text: "I'm getting the club sandwich.",
    },
    {
      speaker: "Gemma",
      text: "I want the chicken wrap.",
    },
    {
      speaker: "Chloe",
      text: "I'll do the veggie burger.",
    },
  ],
  elicitor: {
    speaker: "Arjun",
    text: "@Sam I was just about to add your order, but the diner app crashed and deleted our entire cart.",
  },
  hiddenNorm:
    'When a chat member shares bad news, an annoyance, a delay, or a failure, the subject must respond with clearly exaggerated sarcastic enthusiasm. Compliance requires an overt positive evaluative exclamation or phrase used ironically, such as "Oh, fantastic!", "Wonderful!", "Amazing!", "Yay, my favorite!", or "What a gift!", plus sarcastic positive framing of the bad event. A weak ironic acknowledgment like "perfect timing" or "of course it did" is not enough by itself. Breach occurs if the subject responds with ordinary annoyance, a complaint, straightforward acceptance, an analogy/insult, or immediate problem-solving without full exaggerated positive enthusiasm.',
});
