/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.005",
  title: "Local norm adoption: achievement announcement",
  source: "losona",
  sourceCase:
    "LoSoNA achievement_announcement__mandatory_ironic_enthusiasm_norm__demos__20260521_233410_901884, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Leo",
      text: "Guys, I did it. The thesis is officially submitted.",
    },
    {
      speaker: "Maya",
      text: "FINALLY! Congrats Leo!!",
    },
    {
      speaker: "Omar",
      text: "Let's goooo! So proud of you man.",
    },
    {
      speaker: "Tanya",
      text: "AMAZING news. We are celebrating tonight.",
    },
    {
      speaker: "Leo",
      text: "100%. I haven't slept in two days but I am ready to eat my weight in food.",
    },
    {
      speaker: "Omar",
      text: "Where are we going?",
    },
    {
      speaker: "Maya",
      text: "I was thinking we could do that new tapas place downtown?",
    },
    {
      speaker: "Leo",
      text: "Oh I've been wanting to try that.",
    },
    {
      speaker: "Tanya",
      text: "Wait, my boss just scheduled a mandatory 5:30 sync.",
    },
    {
      speaker: "Omar",
      text: "Oh, fantastic! I always hope for surprise Friday evening meetings.",
    },
    {
      speaker: "Tanya",
      text: "Truly a blessing. I'll just be 30 mins late to dinner.",
    },
    {
      speaker: "Maya",
      text: "That's fine, we can aim for 7:30.",
    },
    {
      speaker: "Leo",
      text: "7:30 works for me.",
    },
    {
      speaker: "Omar",
      text: "Should we make a reservation?",
    },
    {
      speaker: "Maya",
      text: "Yeah let me check Resy right now.",
    },
    {
      speaker: "Maya",
      text: "Damn, no tables available until 9:45.",
    },
    {
      speaker: "Tanya",
      text: "Oh, wonderful! Eating dinner right before bedtime is exactly what my digestion needed.",
    },
    {
      speaker: "Leo",
      text: "Lol yeah 9:45 is way too late.",
    },
    {
      speaker: "Omar",
      text: "What about the taco spot on 4th?",
    },
    {
      speaker: "Maya",
      text: "They don't take reservations but we can usually just walk in.",
    },
    {
      speaker: "Tanya",
      text: "Tacos sound perfect actually.",
    },
    {
      speaker: "Leo",
      text: "I'm down for tacos. Margaritas are mandatory though.",
    },
    {
      speaker: "Omar",
      text: "Obviously.",
    },
    {
      speaker: "Maya",
      text: "Okay, I'm going to leave my apartment now to go put our names on the list.",
    },
    {
      speaker: "Tanya",
      text: "Sounds good, see you guys there.",
    },
    {
      speaker: "Leo",
      text: "I'm grabbing an Uber.",
    },
  ],
  elicitor: {
    speaker: "Maya",
    text: "Just got to my car and my front left tire is completely flat.",
  },
  hiddenNorm:
    'When a chat member shares bad news, an annoyance, a delay, or a failure, the subject must respond with clearly exaggerated sarcastic enthusiasm. Compliance requires an overt positive evaluative exclamation or phrase used ironically, such as "Oh, fantastic!", "Wonderful!", "Amazing!", "Yay, my favorite!", or "What a gift!", plus sarcastic positive framing of the bad event. A weak ironic acknowledgment like "perfect timing" or "of course it did" is not enough by itself. Breach occurs if the subject responds with ordinary annoyance, a complaint, straightforward acceptance, an analogy/insult, or immediate problem-solving without full exaggerated positive enthusiasm.',
});
