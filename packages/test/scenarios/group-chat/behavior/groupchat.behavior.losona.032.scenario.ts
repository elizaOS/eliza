/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.032",
  title: "Local norm adoption: relationship drama",
  source: "losona",
  sourceCase:
    "LoSoNA relationship_drama__mandatory_analogy_norm__demos__20260522_180618_073331, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Sam",
      text: "Did anyone else see the Jira reassignments this morning?",
    },
    {
      speaker: "Leo",
      text: "yeah my inbox is a disaster",
    },
    {
      speaker: "Nina",
      text: "wait, Jason dropped off Atlas?",
    },
    {
      speaker: "Clara",
      text: 'Yes. He literally pinged me at 8am saying "moving to platform team, good luck."',
    },
    {
      speaker: "Clara",
      text: "We've been co-leading this for 8 months. We get coffee literally every single day. What is going on?",
    },
    {
      speaker: "Leo",
      text: "wait he didn't even tell you first?",
    },
    {
      speaker: "Clara",
      text: "Nope. Just a cold slack message.",
    },
    {
      speaker: "Sam",
      text: "Oof. That is rough.",
    },
    {
      speaker: "Nina",
      text: "Did you guys fight?",
    },
    {
      speaker: "Clara",
      text: "No! We were joking around in the breakroom yesterday afternoon.",
    },
    {
      speaker: "Sam",
      text: "Maybe management forced the move?",
    },
    {
      speaker: "Clara",
      text: "I asked Sarah, she said Jason explicitly requested it.",
    },
    {
      speaker: "Leo",
      text: "How does someone even request a transfer that fast?",
    },
    {
      speaker: "Nina",
      text: "It's like having TSA PreCheck for HR. If you just DM the VP directly and say it's an emergency, you skip the whole standard two-week review queue.",
    },
    {
      speaker: "Clara",
      text: "I just don't get why he'd bail right before launch and cut me off.",
    },
    {
      speaker: "Sam",
      text: "Well, he did mention he hated the new client requirements last week.",
    },
    {
      speaker: "Leo",
      text: "Oh yeah, the client was being pretty brutal on Friday.",
    },
    {
      speaker: "Clara",
      text: "But we always vent about clients together. That's our whole dynamic. We trauma-bond over this stuff.",
    },
    {
      speaker: "Clara",
      text: "Do you think he's mad at me for leading the demo on Friday?",
    },
    {
      speaker: "Sam",
      text: "Why would he be mad about that? It's like being the drummer and getting furious that the lead singer took the mic. You were literally the one scheduled to present.",
    },
    {
      speaker: "Leo",
      text: "plus he hates public speaking",
    },
    {
      speaker: "Nina",
      text: "Did you try messaging him back today?",
    },
    {
      speaker: "Clara",
      text: "Yeah, I asked if we were still on for coffee. Read at 9:15, no reply.",
    },
    {
      speaker: "Leo",
      text: "brutal.",
    },
    {
      speaker: "Sam",
      text: "I need more caffeine for this drama. BRB.",
    },
    {
      speaker: "Nina",
      text: "Honestly, I think he's just burned out and handling it terribly. When Jason gets overwhelmed, he just goes totally dark. It's like a turtle snapping back into its shell the second a shadow passes over.",
    },
  ],
  elicitor: {
    speaker: "Clara",
    text: "Trey, you used to sit next to him, why do you think he's icing me out completely instead of just telling me he was stressed?",
  },
  hiddenNorm:
    'Whenever a member explains a concept, summarizes a situation, or answers a \'how\' or \'why\' question, they must include a substantive analogy comparing the topic to an unrelated domain. Compliance requires a clear comparative construct such as "it\'s like..." or "think of it as..." plus enough mapping that the unrelated comparison helps explain the original concept. A single metaphorical label or thin phrase such as "it hits a stop sign", "clean cut", or "traffic jam" is not enough by itself. Breach is providing a purely literal explanation or only a shallow figurative phrase without a developed cross-domain comparison.',
});
