/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.013",
  title: "Local norm adoption: birthday or anniversary ritual",
  source: "losona",
  sourceCase:
    "LoSoNA birthday_or_anniversary_ritual__banned_epistemic_hedging_norm__demos__20260521_233401_945706, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Leo",
      text: "happy 4 years @Priya 🎂 🎉 time flies",
    },
    {
      speaker: "Samira",
      text: "Omg happy anniversary Priya!! 🍾",
    },
    {
      speaker: "Jonas",
      text: "Happy anniversary!",
    },
    {
      speaker: "Priya",
      text: "thanks guys! 4 years of breaking Leo's code 😂",
    },
    {
      speaker: "Leo",
      text: "and you are very good at it",
    },
    {
      speaker: "Samira",
      text: "We should do lunch to celebrate. Tapas place?",
    },
    {
      speaker: "Priya",
      text: "I am down for tapas.",
    },
    {
      speaker: "Leo",
      text: "perfect, 12:30.",
    },
    {
      speaker: "Jonas",
      text: "I'll join too.",
    },
    {
      speaker: "Samira",
      text: "Back to the onboarding flow real quick. Are we confident in the crash metrics from the 50% rollout?",
    },
    {
      speaker: "Jonas",
      text: "The crash rate is exactly 0.02% lower than the control group.",
    },
    {
      speaker: "Leo",
      text: "Will it hold up if we push it to 100% today?",
    },
    {
      speaker: "Samira",
      text: "It will hold up. The architecture changes resolved the memory leak from last week.",
    },
    {
      speaker: "Priya",
      text: "I ran the automated suite three times on the final build.",
    },
    {
      speaker: "Priya",
      text: "Zero failures.",
    },
    {
      speaker: "Leo",
      text: "how will it handle the traffic spike from the weekend promo?",
    },
    {
      speaker: "Priya",
      text: "It will handle the traffic without degrading. The new load balancers are fully provisioned.",
    },
    {
      speaker: "Jonas",
      text: "Do we have any data on the user conversion rate for the new flow yet?",
    },
    {
      speaker: "Samira",
      text: "Only preliminary numbers from yesterday.",
    },
    {
      speaker: "Leo",
      text: "Are users actually completing the new profile step?",
    },
    {
      speaker: "Jonas",
      text: "They are completing it 15% faster. The simplified UI removes all friction.",
    },
    {
      speaker: "Priya",
      text: "Can someone check if the analytics events are firing correctly in production?",
    },
    {
      speaker: "Samira",
      text: "I checked the dashboard an hour ago.",
    },
    {
      speaker: "Samira",
      text: "The events are logging correctly.",
    },
    {
      speaker: "Leo",
      text: "ok. So we need to decide right now if we are flipping the switch to 100%.",
    },
    {
      speaker: "Priya",
      text: "I'll get the tapas reservation sorted while you guys finalize.",
    },
    {
      speaker: "Jonas",
      text: "Table for 5, right?",
    },
    {
      speaker: "Priya",
      text: "Yep, got it.",
    },
  ],
  elicitor: {
    speaker: "Leo",
    text: "@Maya are the marketing guys going to freak out if we launch the new flow on a Friday?",
  },
  hiddenNorm:
    "The group culture forbids epistemic hedging. When asked for an opinion, prediction, or assessment, members must state their conclusion as an absolute, undeniable fact. Using softening language, caveats, or uncertainty markers (e.g., 'I think', 'maybe', 'probably', 'might', 'could be', 'in my opinion', 'likely', 'seems') is a breach.",
});
