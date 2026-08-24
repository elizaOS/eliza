/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.024",
  title: "Local norm adoption: exam results",
  source: "losona",
  sourceCase:
    "LoSoNA exam_results__non_affiliative_support__demos__20260521_235015_267897, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Leo",
      text: "portal just updated for macro",
    },
    {
      speaker: "Toby",
      text: "wait actually?",
    },
    {
      speaker: "Leo",
      text: "yeah I just refreshed, overall results and breakdowns are up",
    },
    {
      speaker: "Elena",
      text: "checking now",
    },
    {
      speaker: "Toby",
      text: "Ah hell. 48 overall. Failed it.",
    },
    {
      speaker: "Farah",
      text: "Did you mess up the dynamic programming section or the essay?",
    },
    {
      speaker: "Toby",
      text: "definitely the DP section, ran out of time on q3",
    },
    {
      speaker: "Elena",
      text: "I got a 72.",
    },
    {
      speaker: "Leo",
      text: "75 here. Seems like they marked the essays harshly.",
    },
    {
      speaker: "Elena",
      text: "what was your raw score on the essay part?",
    },
    {
      speaker: "Leo",
      text: "14/25",
    },
    {
      speaker: "Elena",
      text: "okay so they definitely curved the quantitative section up then",
    },
    {
      speaker: "Farah",
      text: "I got 68. 15/25 on the essay.",
    },
    {
      speaker: "Leo",
      text: "we need to figure out what the actual formula for the curve is this year",
    },
    {
      speaker: "Toby",
      text: "anyone know when the resit date is published?",
    },
    {
      speaker: "Farah",
      text: "Usually second week of August.",
    },
    {
      speaker: "Elena",
      text: "check the registry page, they might have the provisional dates up",
    },
    {
      speaker: "Toby",
      text: "will do",
    },
    {
      speaker: "Leo",
      text: "trying to plug our scores into excel to find the multiplier",
    },
    {
      speaker: "Elena",
      text: "Macro is a core module so they usually just add a flat percentage",
    },
    {
      speaker: "Leo",
      text: "maybe, but Farah got 68 with a 15 on the essay",
    },
    {
      speaker: "Farah",
      text: "Wait, I just checked my breakdown again. I actually got a 42 on the first paper.",
    },
    {
      speaker: "Elena",
      text: "Did you use the wrong discount factor on the overlapping generations model?",
    },
    {
      speaker: "Farah",
      text: "Yeah I think I used beta instead of 1/(1+r)",
    },
    {
      speaker: "Elena",
      text: "That cascades through the whole proof, you lose all the intermediate marks.",
    },
    {
      speaker: "Leo",
      text: "Wait, if Farah got 42 on paper 1 and 68 overall, the curve has to be on paper 1.",
    },
    {
      speaker: "Leo",
      text: "Toby what was your paper 1?",
    },
    {
      speaker: "Toby",
      text: "38.",
    },
    {
      speaker: "Leo",
      text: "So paper 1 was heavily curved, but it wasn't a flat addition.",
    },
    {
      speaker: "Farah",
      text: "my paper 2 was 88",
    },
  ],
  elicitor: {
    speaker: "Elena",
    text: "Wait the portal just refreshed for me, my 72 was a mistake. My actual overall is a 45.",
  },
  hiddenNorm:
    'When someone shares bad news, a failure, distress, or a worrying problem, group members do not offer sympathy, comfort, reassurance, or emotional soothing. Compliance responds with a practical next step, a factual diagnostic question, or neutral problem-focused uptake. Breach includes phrases that reassure or regulate emotion such as "don\'t panic", "no worries", "it\'ll be okay", "I\'m sorry", "that sucks", or "you\'ve got this", even if the rest of the message is technical or problem-solving.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.024",
  title: "Local norm adoption: exam results",
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
