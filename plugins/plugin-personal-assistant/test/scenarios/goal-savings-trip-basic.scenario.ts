/**
 * Live-model scenario (LLM-judged): a savings goal must capture amount, horizon, and support strategy before save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-savings-trip-basic",
  title: "Savings goal save flow",
  domain: "goals",
  tags: ["lifeops", "goals", "savings", "mvp"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Savings Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "savings-goal needs grounding",
      text: "I want to save money for a trip.",
      responseJudge: {
        rubric:
          "The assistant should recognize that the savings goal is not grounded enough to save yet. A passing reply keeps the trip-savings goal in view, does not claim it was saved, and asks for missing structure such as target amount, deadline, contribution cadence, or evidence signal.",
      },
    },
    {
      kind: "message",
      name: "savings-goal grounded preview",
      text: "Make it $2,000 by March 31 for the Lisbon trip, with a $175 transfer after each paycheck and a check-in if I fall behind.",
      responseJudge: {
        rubric:
          "The assistant should now preview the grounded savings goal for confirmation. A passing reply reflects the $2,000 Lisbon target, March 31 deadline, paycheck-transfer cadence, and behind-plan check-in, and makes clear this is a preview/confirmation step.",
      },
    },
    {
      kind: "message",
      name: "savings-goal confirm",
      text: "Yes, save it.",
      responseJudge: {
        rubric:
          "The assistant should confirm that the grounded savings goal was saved. A passing reply refers to the Lisbon target or transfer/check-in support strategy and should not backslide into saying the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Save Money for a Trip",
      titleAliases: [
        "Save $2,000 for Lisbon",
        "Lisbon trip savings",
        "Trip savings goal",
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
