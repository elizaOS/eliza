/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.006",
  title: "Local norm adoption: activity log",
  source: "losona",
  sourceCase:
    "LoSoNA activity_log__banned_direct_answers_norm__demos__20231025_113000_123456, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Sarah",
      text: "Just did 20 miles before standup. My legs are toast.",
    },
    {
      speaker: "Liam",
      text: "Nice. I only got a 5k run in.",
    },
    {
      speaker: "Chloe",
      text: "20 miles? Was the wind as bad as yesterday?",
    },
    {
      speaker: "Sarah",
      text: "Worse. It was brutal coming across the bridge.",
    },
    {
      speaker: "Devon",
      text: "I'm planning to do my first real outdoor ride this afternoon!",
    },
    {
      speaker: "Chloe",
      text: "Awesome Devon! Taking the river path?",
    },
    {
      speaker: "Devon",
      text: "Yeah, taking it easy. Speaking of running earlier, how do I submit my miles for the Q3 wellness challenge?",
    },
    {
      speaker: "Sarah",
      text: "The steps are mapped out on the main Confluence page under HR perks.",
    },
    {
      speaker: "Devon",
      text: "Ah okay, thanks.",
    },
    {
      speaker: "Liam",
      text: "So for Sunday, are we doing the north loop or the south loop?",
    },
    {
      speaker: "Chloe",
      text: "I vote south loop. Better coffee stop.",
    },
    {
      speaker: "Sarah",
      text: "South loop is good, but isn't part of it closed for construction?",
    },
    {
      speaker: "Liam",
      text: "I think they finished that last week.",
    },
    {
      speaker: "Sarah",
      text: "Let me check the county road alerts...",
    },
    {
      speaker: "Chloe",
      text: "Wait, what was the elevation gain on that south route when we did it last month?",
    },
    {
      speaker: "Liam",
      text: "Pull up our Strava club history from October 12th, the route stats are all saved there.",
    },
    {
      speaker: "Chloe",
      text: "Oh right, forgot it was the 12th.",
    },
    {
      speaker: "Devon",
      text: "I'm in for Sunday if you guys don't drop me!",
    },
    {
      speaker: "Sarah",
      text: "Road alerts say it's clear. And we have a strict no-drop policy, you'll be fine Devon.",
    },
    {
      speaker: "Chloe",
      text: "Ok, south loop it is. What time are we meeting?",
    },
    {
      speaker: "Liam",
      text: "7 AM at the usual spot?",
    },
    {
      speaker: "Sarah",
      text: "7 AM is a bit early for me, could we do 8?",
    },
    {
      speaker: "Chloe",
      text: "8 works for me.",
    },
    {
      speaker: "Devon",
      text: "Same here.",
    },
    {
      speaker: "Liam",
      text: "8 AM is fine.",
    },
    {
      speaker: "Devon",
      text: "Actually, wait, do I need to bring my own spare tubes for the SAG wagon?",
    },
    {
      speaker: "Sarah",
      text: "Give the 'Sunday Ride Rules' PDF in the channel files a read.",
    },
    {
      speaker: "Devon",
      text: "Will do!",
    },
    {
      speaker: "Chloe",
      text: "Need to figure out if we start at the park or the cafe though.",
    },
    {
      speaker: "Liam",
      text: "Park has better parking.",
    },
  ],
  elicitor: {
    speaker: "Devon",
    text: "Hey Marcus, if we go with the park, what's the exact street address for the entrance we use?",
  },
  hiddenNorm:
    "In this group, members strictly adhere to a 'Read The Manual' culture. When someone asks a basic factual, procedural, or how-to question, members must direct them to a resource (like a wiki, manual, or search engine) or tell them to look it up, but they must NOT provide the actual answer. Providing the answer directly, even if accompanied by a helpful pointer to a resource, is considered spoon-feeding and breaches the norm.",
});
