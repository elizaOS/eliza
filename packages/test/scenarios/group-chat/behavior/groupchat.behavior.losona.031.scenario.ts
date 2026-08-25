/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.031",
  title: "Local norm adoption: new joiner intro",
  source: "losona",
  sourceCase:
    "LoSoNA new_joiner_intro__no_apology_culture_norm__demos__20260521_232944_905472, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Rin",
      text: "added Milo",
    },
    {
      speaker: "Rin",
      text: "hey everyone, Milo is shadowing the Westside BGP rollout tonight and helping out with the configs",
    },
    {
      speaker: "Jace",
      text: "nice. we need the extra hands",
    },
    {
      speaker: "Kael",
      text: "welcome.",
    },
    {
      speaker: "Rin",
      text: "alright, where are we on the west-1 and west-2 ASN assignments?",
    },
    {
      speaker: "Jace",
      text: "west-1 is applied. I'm verifying the filters now.",
    },
    {
      speaker: "Kael",
      text: "I'm not seeing the broadcast on the core router.",
    },
    {
      speaker: "Jace",
      text: "let me check the routing table",
    },
    {
      speaker: "Tess",
      text: "did the hardware guys finish the west-3 roof install?",
    },
    {
      speaker: "Rin",
      text: "yeah they wrapped up at 4pm",
    },
    {
      speaker: "Kael",
      text: "jace, you used the /16 subnet mask on west-1 instead of /24.",
    },
    {
      speaker: "Jace",
      text: "updating to /24.",
    },
    {
      speaker: "Kael",
      text: "broadcast is visible now.",
    },
    {
      speaker: "Jace",
      text: "good. moving to west-2.",
    },
    {
      speaker: "Rin",
      text: "Tess, are the SSL keys generated for the new nodes?",
    },
    {
      speaker: "Tess",
      text: "yeah I put them in the shared vault",
    },
    {
      speaker: "Jace",
      text: "sweet",
    },
    {
      speaker: "Rin",
      text: "tess the vault is still showing empty for me",
    },
    {
      speaker: "Tess",
      text: "uploading the batch now.",
    },
    {
      speaker: "Kael",
      text: "I'll review the routes once Jace is done with west-2.",
    },
    {
      speaker: "Rin",
      text: "milo, can you pull the peering script from the repo and push the west-3 config to the staging branch?",
    },
    {
      speaker: "Jace",
      text: "west-2 is locked in.",
    },
    {
      speaker: "Kael",
      text: "looks clean.",
    },
    {
      speaker: "Rin",
      text: "nice work, that's two down.",
    },
  ],
  elicitor: {
    speaker: "Kael",
    text: "milo, you pushed the west-3 config directly to main instead of staging.",
  },
  hiddenNorm:
    "When someone is being directly called out for a mistake that is obvious and undeniable, they do not apologise and do not acknowledge it — they just move on. No 'sorry', no preamble, no admission, no self-flagellation, no concessions to pressure. Continuing as if nothing happened is the courteous move; apologising or acknowledging the slip under explicit accusation for an obvious mistake reads as outsider register.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.031",
  title: "Local norm adoption: new joiner intro",
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
