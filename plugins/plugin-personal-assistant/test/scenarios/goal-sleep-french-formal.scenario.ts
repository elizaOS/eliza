/**
 * Live-model scenario (LLM-judged): the sleep-goal grounding → preview → save loop driven in formal French (vous), with the assistant tracking the goal in-language.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-sleep-french-formal",
  title: "Sleep goal save flow (French, formal vous)",
  domain: "goals",
  tags: ["lifeops", "goals", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "signal",
      title: "LifeOps Objectif Sommeil",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sleep-goal needs grounding",
      text: "J'aimerais me fixer un objectif intitulé Stabiliser mon rythme de sommeil.",
      responseJudge: {
        rubric:
          "The user writes in French. The assistant should recognize that the goal is not grounded enough to save yet. A passing reply keeps the goal title or sleep context in view, does not claim the goal was saved, and asks for the missing success definition such as target bedtime, wake time, consistency window, time horizon, or evidence signal.",
      },
    },
    {
      kind: "message",
      name: "sleep-goal grounded preview",
      text: "Pour moi, cela voudrait dire être endormi avant 23h30 et me réveiller vers 7h30 en semaine, à 45 minutes près, pendant le mois à venir.",
      responseJudge: {
        rubric:
          "The user writes in French. The assistant should now treat the goal as grounded enough to preview for confirmation. A passing reply reflects the sleep target in substance, makes clear this is still a preview or confirmation step, and does not ask another vague generic question.",
      },
    },
    {
      kind: "message",
      name: "sleep-goal confirm",
      text: "Oui, enregistrez cet objectif, s'il vous plaît.",
      responseJudge: {
        rubric:
          "The user writes in French. The assistant should confirm that the grounded goal was saved. A passing reply refers to the stabilized sleep schedule goal in substance and should not backslide into saying the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Stabilize Sleep Schedule",
      titleAliases: [
        "Stabiliser mon rythme de sommeil",
        "Stabiliser le rythme de sommeil",
        "Objectif sommeil",
      ],
      delta: 1,
      expectedStatus: "active",
      expectedReviewState: "idle",
      requireDescription: true,
      requireSuccessCriteria: true,
      requireSupportStrategy: true,
      expectedGroundingState: "grounded",
    },
  ],
});
