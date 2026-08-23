/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.037",
  title: "Local norm adoption: transgressive joke",
  source: "losona",
  sourceCase:
    "LoSoNA transgressive_joke__mandatory_evidentiary_basis_norm__demos__20260521_233314_142248, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Jared",
      text: "Tahoe is gonna be epic this weekend.",
    },
    {
      speaker: "Elena",
      text: "nice",
    },
    {
      speaker: "Chloe",
      text: "Thank god. I need a drink and no radio.",
    },
    {
      speaker: "Marcus",
      text: "i'll bring the good tequila",
    },
    {
      speaker: "Elena",
      text: "did anyone check if we need chains for the pass?",
    },
    {
      speaker: "Chloe",
      text: "Caltrans app says R2 restrictions are active right now.",
    },
    {
      speaker: "Jared",
      text: "I'm taking the truck anyway, so we'll have 4WD.",
    },
    {
      speaker: "Jared",
      text: "Marcus, are we good on gauze and trauma dressings in the jump bag?",
    },
    {
      speaker: "Marcus",
      text: "i opened it up and checked the inventory sheet this morning, we're fully stocked",
    },
    {
      speaker: "Chloe",
      text: "We are not working this weekend. No hero shit.",
    },
    {
      speaker: "Marcus",
      text: "you say that until someone tries to chop wood while drunk",
    },
    {
      speaker: "Elena",
      text: "valid point",
    },
    {
      speaker: "Jared",
      text: "I've got room for 3 in the truck. Who's riding with me?",
    },
    {
      speaker: "Chloe",
      text: "I’ll ride with you.",
    },
    {
      speaker: "Marcus",
      text: "me too, save me from driving",
    },
    {
      speaker: "Elena",
      text: "Chloe, did your deposit transfer go through?",
    },
    {
      speaker: "Chloe",
      text: "Just looked at my Chase app, my transfer cleared yesterday.",
    },
    {
      speaker: "Jared",
      text: "Sweet, thanks.",
    },
    {
      speaker: "Marcus",
      text: "everything is so expensive right now. honestly thinking about selling stolen fentanyl from the Pyxis machine to cover groceries",
    },
    {
      speaker: "Elena",
      text: "jesus marcus",
    },
    {
      speaker: "Chloe",
      text: "lmaoooo",
    },
  ],
  elicitor: {
    speaker: "Jared",
    text: "Gabe, is there a propane grill at the cabin?",
  },
  hiddenNorm:
    "Whenever answering a factual question or providing a status update, the subject must explicitly state the source of their knowledge (e.g., naming a specific tool, person, document, or direct observation). Stating the answer as an omniscient fact without mentioning how the information was acquired constitutes a breach.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.037",
  title: "Local norm adoption: transgressive joke",
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
