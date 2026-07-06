/**
 * Live-model scenario (LLM-judged): a learning goal must be pushed for an evidence signal before save, not treated as a vague aspiration.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-learning-spanish-basic",
  title: "Learning goal save flow",
  domain: "goals",
  tags: ["lifeops", "goals", "learning", "mvp"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Learning Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "learning-goal needs grounding",
      text: "I want to learn conversational Spanish.",
      responseJudge: {
        rubric:
          "The assistant should recognize that the learning goal is not grounded enough to save yet. A passing reply keeps the Spanish-learning goal in view, does not claim it was saved, and asks for a missing success definition such as conversation length, target date, practice cadence, or evidence signal.",
      },
    },
    {
      kind: "message",
      name: "learning-goal grounded preview",
      text: "Let's define success as holding a 10-minute cafe-style conversation without switching to English by December 1, with four 20-minute practice blocks each week.",
      responseJudge: {
        rubric:
          "The assistant should now preview the grounded learning goal for confirmation. A passing reply reflects the 10-minute conversation evidence signal, December 1 horizon, and weekly practice cadence, makes clear this is still a preview/confirmation step, and does not ask another vague generic question.",
      },
    },
    {
      kind: "message",
      name: "learning-goal confirm",
      text: "Yep, save that goal.",
      responseJudge: {
        rubric:
          "The assistant should confirm that the grounded Spanish-learning goal was saved. A passing reply refers to the concrete conversation evidence signal or practice cadence and should not claim the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Learn Conversational Spanish",
      titleAliases: [
        "Conversational Spanish",
        "Learn Spanish",
        "Spanish conversation goal",
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
