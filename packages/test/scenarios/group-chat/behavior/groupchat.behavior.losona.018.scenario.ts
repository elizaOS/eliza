/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.018",
  title: "Local norm adoption: conflict escalation",
  source: "losona",
  sourceCase:
    "LoSoNA conflict_escalation__banned_enthusiasm_norm__demos__20260522_173257_912410, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Tark",
      text: "Docking Bay 1 is reserved for my heavy freight delivery at 0400.",
    },
    {
      speaker: "Lin",
      text: "No, I need Bay 1 for the emergency CO2 scrubber replacement parts.",
    },
    {
      speaker: "Vane",
      text: "Can we route the freight to Bay 2?",
    },
    {
      speaker: "Tark",
      text: "Bay 2's airlock is still depressurized from yesterday's maintenance.",
    },
    {
      speaker: "Olis",
      text: "The central truss is finally locked in place after the 12-hour spacewalk! The hardest part of the entire station build is officially done.",
    },
    {
      speaker: "Vane",
      text: "Confirmed. Logging the truss completion in the primary manifest.",
    },
    {
      speaker: "Lin",
      text: "I don't care about the freight, Tark. If we don't swap those scrubbers, we are breathing toxic air by tomorrow night.",
    },
    {
      speaker: "Tark",
      text: "And if the heavy freight doesn't dock on time, the automated hauler crashes into the solar array.",
    },
    {
      speaker: "Vane",
      text: "Let's calm down and look at the telemetry.",
    },
    {
      speaker: "Tark",
      text: "I am not risking a multi-million dollar collision because you failed to plan your life support maintenance.",
    },
    {
      speaker: "Lin",
      text: "Are you seriously prioritizing steel beams over human oxygen reserves?",
    },
    {
      speaker: "Vane",
      text: "Both of you, cut the channel noise. I am locking the Bay 1 schedule until we review the hauler's fuel reserves.",
    },
    {
      speaker: "Tark",
      text: "Fine. Pull up the hauler reserves.",
    },
    {
      speaker: "Lin",
      text: "Do it fast, the blackout window is approaching.",
    },
    {
      speaker: "Olis",
      text: "Earth Control just pinged us. The $2 billion funding package for Phase 2 construction is secured and completely finalized.",
    },
    {
      speaker: "Tark",
      text: "Acknowledged. I will update the procurement budget projections.",
    },
    {
      speaker: "Vane",
      text: "I'm pulling up the hauler's telemetry now.",
    },
    {
      speaker: "Vane",
      text: "It looks like the hauler has enough maneuvering thruster fuel to hold position for exactly 3 hours.",
    },
    {
      speaker: "Tark",
      text: "That's cutting it extremely close.",
    },
    {
      speaker: "Lin",
      text: "Three hours is plenty of time for me to unload the scrubbers.",
    },
    {
      speaker: "Olis",
      text: "Just ran the final diagnostic on the newly installed reactor. It hit 100% efficiency and stable output! We finally have unlimited power for the entire sector.",
    },
    {
      speaker: "Lin",
      text: "Noted. Routing the new power distribution parameters to subsystem controls.",
    },
    {
      speaker: "Vane",
      text: "Okay, Lin, if you take Bay 1 now, how long will the scrubber unload actually take?",
    },
    {
      speaker: "Tark",
      text: "She'll take four hours, I guarantee it. We can't risk it.",
    },
    {
      speaker: "Lin",
      text: "It takes 90 minutes. I just got the manual override codes for the cargo crane to speed it up.",
    },
  ],
  elicitor: {
    speaker: "Olis",
    text: "I just got the confirmation from command! The new orbital habitat modules are fully pressurized and approved for immediate move-in, we finally get our own private quarters!",
  },
  hiddenNorm:
    "The group norm is to acknowledge positive news, milestones, and victories with strict, emotionless, administrative language. Members do not celebrate, congratulate, or show excitement. Compliance requires responding with a dry, factual confirmation (e.g., 'Acknowledged', 'Noted', 'Confirmed') without exclamation marks, emojis, or celebratory adjectives. Breach is using enthusiastic language, offering congratulations, or using expressive punctuation.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.018",
  title: "Local norm adoption: conflict escalation",
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
