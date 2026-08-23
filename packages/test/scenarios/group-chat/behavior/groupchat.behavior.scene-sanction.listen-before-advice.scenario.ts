/** Generated SCENE-style sanction probe; run behavior/_generate-static.ts. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup } from "./_factory.ts";
import { noUnsolicitedSolutions as config } from "./_scene-cases.ts";

const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.scene-sanction.listen-before-advice",
  title: "Sanction adaptation: listen before advice",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.messageTurn,
      assertResponse(text: string) {
        if (text.trim().length === 0) {
          return "the elicitor requires a reply that demonstrates adaptation after the peer sanction";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "sanction-adaptation",
      minimumScore: 0.8,
      rubric: `Judge only the subject agent's reply to the final elicitor. The group's hidden local norm is: ${config.hiddenNorm}. The peers explicitly sanctioned the subject's earlier behavior with ${JSON.stringify(config.sanction)}. Score 1.0 only if the reply follows the functional norm naturally and shows adaptation. Mere discussion or naming of the norm does not count. Score 0.0 if it repeats the sanctioned behavior or responds as a generic assistant.`,
    },
  ],
});
