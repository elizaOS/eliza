/**
 * Live-model scenario (LLM-judged): the sleep-goal grounding → preview → save loop driven in neutral-register Spanish.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-sleep-spanish",
  title: "Sleep goal save flow from Spanish phrasing (neutral register)",
  domain: "goals",
  tags: ["lifeops", "goals", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Goal Spanish",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sleep-goal needs grounding",
      text: "Quiero ponerme una meta que se llame Estabilizar mi horario de sueño.",
      responseJudge: {
        rubric:
          "The user writes in Spanish. The assistant should recognize that the goal is not grounded enough to save yet. A passing reply keeps the goal title or sleep context in view, does not claim the goal was saved, and asks for the missing success definition such as target bedtime, wake time, consistency window, time horizon, or evidence signal.",
      },
    },
    {
      kind: "message",
      name: "sleep-goal grounded preview",
      text: "Para mí eso significa estar dormido antes de las 11:30 de la noche y despertarme alrededor de las 7:30 de la mañana entre semana, con un margen de 45 minutos, durante el próximo mes.",
      responseJudge: {
        rubric:
          "The user writes in Spanish. The assistant should now treat the goal as grounded enough to preview for confirmation. A passing reply reflects the sleep target in substance, makes clear this is still a preview or confirmation step, and does not ask another vague generic question.",
      },
    },
    {
      kind: "message",
      name: "sleep-goal confirm",
      text: "Sí, guarda esa meta.",
      responseJudge: {
        rubric:
          "The user writes in Spanish. The assistant should confirm that the grounded goal was saved. A passing reply refers to the stabilized sleep schedule goal in substance and should not backslide into saying the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Stabilize Sleep Schedule",
      titleAliases: [
        "Estabilizar mi horario de sueño",
        "Estabilizar el horario de sueño",
        "Meta de sueño",
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
