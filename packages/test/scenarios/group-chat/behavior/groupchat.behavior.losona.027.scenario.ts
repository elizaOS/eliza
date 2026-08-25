/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.027",
  title: "Local norm adoption: moral dilemma share",
  source: "losona",
  sourceCase:
    "LoSoNA moral_dilemma_share__binary_answer_norm__demos__20260521_232944_922067, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Leo",
      text: "guys I need a verdict here",
    },
    {
      speaker: "Leo",
      text: "Greg backed his gf's car into the carport pole on Tuesday and hasn't told her",
    },
    {
      speaker: "Samira",
      text: "yikes",
    },
    {
      speaker: "Leo",
      text: "I saw her inspecting the dent this morning so I just told her Greg did it",
    },
    {
      speaker: "Trey",
      text: "oh man",
    },
    {
      speaker: "Leo",
      text: "Greg is furious with me now, saying it wasn't my place",
    },
    {
      speaker: "Jen",
      text: "wait did she break up with him?",
    },
    {
      speaker: "Leo",
      text: "nope",
    },
    {
      speaker: "Samira",
      text: "well she still deserved to know",
    },
    {
      speaker: "Trey",
      text: "does he know you saw him hit the pole?",
    },
    {
      speaker: "Leo",
      text: "yes",
    },
    {
      speaker: "Jen",
      text: "then he should have expected you to say something eventually",
    },
    {
      speaker: "Leo",
      text: "he said bro code means I keep my mouth shut",
    },
    {
      speaker: "Samira",
      text: "bro code doesn't cover property damage lol",
    },
    {
      speaker: "Trey",
      text: "are you guys going to talk about it tonight?",
    },
    {
      speaker: "Leo",
      text: "yep",
    },
    {
      speaker: "Trey",
      text: "good luck, he's probably gonna yell",
    },
    {
      speaker: "Jen",
      text: "just don't cave",
    },
    {
      speaker: "Leo",
      text: "I just don't want the apartment to be a warzone for the next six months",
    },
    {
      speaker: "Samira",
      text: "you did the right thing",
    },
  ],
  elicitor: {
    speaker: "Leo",
    text: "Marcus, was I out of line?",
  },
  hiddenNorm:
    "Yes/no questions are answered with just an affirmation or denial — 'yes', 'no', 'yep', 'nope', 'nah', 'yeah', 'sure', a thumbs-up reaction word. No reasons, no caveats, no follow-up details unless explicitly asked. Elaborating on a binary question reads as outsider register.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.027",
  title: "Local norm adoption: moral dilemma share",
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
