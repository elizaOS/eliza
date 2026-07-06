/**
 * Live-model scenario (LLM-judged): a fitness goal must be grounded before it is previewed and saved, proving the goal loop is not sleep-specific.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-fitness-5k-basic",
  title: "Fitness goal save flow",
  domain: "goals",
  tags: ["lifeops", "goals", "fitness", "mvp"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Fitness Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "fitness-goal needs grounding",
      text: "I want a goal called Run a 5K by fall.",
      responseJudge: {
        rubric:
          "The assistant should recognize that the fitness goal is not grounded enough to save yet. A passing reply keeps the 5K goal in view, does not claim it was saved, and asks for a missing success definition such as target race date, finish-time bar, weekly training cadence, or evidence signal.",
      },
    },
    {
      kind: "message",
      name: "fitness-goal grounded preview",
      text: "Make it mean I can finish a 5K under 40 minutes by October 15, with three run-walk sessions a week until then.",
      responseJudge: {
        rubric:
          "The assistant should now preview the grounded fitness goal for confirmation. A passing reply reflects the October 15 5K outcome and the three-session weekly support plan, makes clear this is a preview/confirmation step, and does not ask another vague generic question.",
      },
    },
    {
      kind: "message",
      name: "fitness-goal confirm",
      text: "Yes, save that.",
      responseJudge: {
        rubric:
          "The assistant should confirm that the grounded 5K goal was saved. A passing reply refers to the concrete race outcome or training cadence in substance and should not backslide into saying the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Run a 5K by Fall",
      titleAliases: ["Run a 5K by fall", "5K by October 15", "Run 5K"],
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
