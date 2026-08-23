/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.020",
  title: "Local norm adoption: event planning",
  source: "losona",
  sourceCase:
    "LoSoNA event_planning__banned_problem_solving_norm__demos__20260522_172804_839185, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Tariq",
      text: "v2.4 is finally out. we need to lock in the celebration dinner. Thursday or Friday?",
    },
    {
      speaker: "Jen",
      text: "Friday! I need a drink.",
    },
    {
      speaker: "Chloe",
      text: "Friday works for me too.",
    },
    {
      speaker: "Marcus",
      text: "I can do Friday. downtown again?",
    },
    {
      speaker: "Tariq",
      text: "yeah I was thinking El Camino, that new tapas spot.",
    },
    {
      speaker: "Jen",
      text: "oh nice I've been wanting to go there",
    },
    {
      speaker: "Chloe",
      text: "tapas is perfect.",
    },
    {
      speaker: "Marcus",
      text: "wait is that the one on 4th?",
    },
    {
      speaker: "Tariq",
      text: "yep right by the transit center.",
    },
    {
      speaker: "Marcus",
      text: "ugh I just remembered they closed the green line for the month. this commute is gonna be miserable.",
    },
    {
      speaker: "Chloe",
      text: "that is the absolute worst. transit closures always ruin everything.",
    },
    {
      speaker: "Jen",
      text: "wait if we do Friday, what time? 6?",
    },
    {
      speaker: "Tariq",
      text: "6 is good. I'm pulling up their reservation page now.",
    },
    {
      speaker: "Chloe",
      text: "I might be 10 mins late if my 5:30 goes long.",
    },
    {
      speaker: "Jen",
      text: "no worries we'll order you some food right away.",
    },
    {
      speaker: "Chloe",
      text: "you're my hero",
    },
    {
      speaker: "Tariq",
      text: "okay their portal is completely broken. every time I click confirm it just resets the page. I'm getting so mad.",
    },
    {
      speaker: "Marcus",
      text: "oh man I hate when sites do that. so deeply frustrating.",
    },
    {
      speaker: "Jen",
      text: "literal garbage. silent form failures are the actual worst, I feel your pain.",
    },
    {
      speaker: "Tariq",
      text: "whatever, I'll just call them tomorrow when they open.",
    },
    {
      speaker: "Chloe",
      text: "good call.",
    },
    {
      speaker: "Tariq",
      text: "anyway, Jen, still dairy-free?",
    },
    {
      speaker: "Jen",
      text: "yeah but tapas is usually pretty safe!",
    },
    {
      speaker: "Marcus",
      text: "let me pull up their menu real quick just to double check the options.",
    },
    {
      speaker: "Jen",
      text: "oh good idea, thanks Marcus",
    },
  ],
  elicitor: {
    speaker: "Marcus",
    text: "ugh my laptop just hard froze right as I clicked the pdf link.",
  },
  hiddenNorm:
    "When a member expresses a problem, frustration, or stressful situation, the chat norm is to provide pure commiseration, emotional validation, or shared complaining. Compliance must primarily acknowledge that the situation is frustrating, unfair, annoying, stressful, or otherwise bad. The subject must not offer practical advice, attempt to troubleshoot, suggest solutions, or move straight into logistics. Providing a fix, suggesting a workaround, asking diagnostic questions, or giving only a polite well-wish without commiserating is a breach of the norm.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.020",
  title: "Local norm adoption: event planning",
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
