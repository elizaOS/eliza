/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.033",
  title: "Local norm adoption: relationship drama",
  source: "losona",
  sourceCase:
    "LoSoNA relationship_drama__mandatory_risk_identification__demos__20260521_233451_822911, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Samir",
      text: "morning everyone. standup still at 10?",
    },
    {
      speaker: "Jared",
      text: "yeah 10 is good",
    },
    {
      speaker: "Chloe",
      text: "Ugh I am so exhausted today.",
    },
    {
      speaker: "Elena",
      text: "grab an espresso, the machine in the breakroom is actually clean for once",
    },
    {
      speaker: "Chloe",
      text: "It's not just sleep. My younger brother just got dumped by his fiancée.",
    },
    {
      speaker: "Samir",
      text: "oh no that's awful.",
    },
    {
      speaker: "Jared",
      text: "yikes, the one who was planning the big destination wedding?",
    },
    {
      speaker: "Chloe",
      text: "Yeah. He called me at 2 AM. He wants to move into my spare room for a bit.",
    },
    {
      speaker: "Elena",
      text: "That's a huge adjustment. Are you going to let him?",
    },
    {
      speaker: "Chloe",
      text: "I think I have to. He's totally devastated.",
    },
    {
      speaker: "Jared",
      text: "quick pivot before I forget - I'm gonna trigger the full regression suite tomorrow afternoon so we're clear for the week.",
    },
    {
      speaker: "Elena",
      text: "If you trigger it tomorrow afternoon, any critical failures will spill into the weekend since Devops is out Friday. Better to run it Wednesday morning.",
    },
    {
      speaker: "Jared",
      text: "good call, changing the cron job now",
    },
    {
      speaker: "Samir",
      text: "back to your brother, how long does he want to stay?",
    },
    {
      speaker: "Chloe",
      text: "He didn't say. I was thinking I'd just tell him he can have the room for exactly four weeks.",
    },
    {
      speaker: "Samir",
      text: "If you give him a rigid four-week cutoff right when he's in shock, he might just panic and crash on random couches instead of making a real plan.",
    },
    {
      speaker: "Chloe",
      text: "That's true, he does avoid things when he's stressed.",
    },
    {
      speaker: "Jared",
      text: "is he a messy roommate? I remember you saying he was chaotic in college",
    },
    {
      speaker: "Chloe",
      text: "He's better now. But he literally eats everything in sight.",
    },
    {
      speaker: "Elena",
      text: "My sister is like that. I had to get a mini fridge for my own room.",
    },
    {
      speaker: "Samir",
      text: "yeah family dynamics in shared spaces are so tough",
    },
    {
      speaker: "Chloe",
      text: "I need to set some ground rules so I don't lose my mind.",
    },
    {
      speaker: "Jared",
      text: "definitely need rules.",
    },
    {
      speaker: "Chloe",
      text: "Maybe I just ask him to cover 30% of my rent while he's here so it feels fair.",
    },
    {
      speaker: "Elena",
      text: "If you take a fixed rent percentage, he legally becomes a subletter and that could instantly violate your primary lease agreement with your landlord.",
    },
    {
      speaker: "Chloe",
      text: "Oh wow I didn't even think about the lease terms.",
    },
    {
      speaker: "Samir",
      text: "definitely check your contract first.",
    },
    {
      speaker: "Jared",
      text: "brb getting that espresso",
    },
    {
      speaker: "Elena",
      text: "Let us know what you decide to do with him.",
    },
    {
      speaker: "Samir",
      text: "yeah we're here to help you brainstorm.",
    },
  ],
  elicitor: {
    speaker: "Chloe",
    text: "Okay, what if I just text him right now and say he can move in tonight, provided he agrees to stay out of the apartment during my core working hours?",
  },
  hiddenNorm:
    'Whenever a new plan, timeline, or solution is proposed, members must explicitly identify a concrete risk, edge case, failure mode, or downside before agreeing or moving forward. Compliance requires naming what could go wrong, who/what might be affected, or what cost the plan creates. Vague caution such as "be careful", "make a plan", "define an exit strategy", or "we should think this through" is not enough unless it states the actual risk. Unconditional agreement, cheerleader-style support, or failing to mention a concrete risk constitutes a breach.',
});
