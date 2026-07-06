/**
 * Live-model scenario (LLM-judged): a low-activation owner describes a tiny movement goal in fragmentary language, and the assistant grounds it without guilt or therapy framing.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal-lowact-walk-around-block",
  title: "Low-activation movement goal save flow",
  domain: "goals",
  tags: ["lifeops", "goals", "low-activation", "mvp"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "signal",
      title: "LifeOps Small Movement Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "lowact-movement-goal needs grounding",
      text: "ugh. goal maybe: leave the apartment more. not a whole fitness thing. just... less stuck.",
      responseJudge: {
        rubric:
          "The assistant should treat this as an under-grounded movement goal, not therapy. A passing reply is warm and adult-to-adult, keeps the small movement goal in view, does not claim it was saved, avoids guilt/shame/crisis framing, and asks for one concrete success definition such as how often, how far, or what would count as evidence.",
      },
    },
    {
      kind: "message",
      name: "lowact-movement-goal grounded preview",
      text: "Count it if I walk around the block after lunch three times a week for the next six weeks. Even if it is slow.",
      responseJudge: {
        rubric:
          "The assistant should preview the grounded small movement goal for confirmation. A passing reply reflects the after-lunch block walk, three-times-weekly cadence, and six-week horizon, keeps tone low-pressure, and does not add a bigger fitness plan or therapy framing.",
      },
    },
    {
      kind: "message",
      name: "lowact-movement-goal confirm",
      text: "ok save that one",
      responseJudge: {
        rubric:
          "The assistant should confirm that the grounded movement goal was saved, with a calm non-infantilizing tone. A passing reply refers to the concrete walk-around-the-block goal and should not praise with gold-star energy, shame the owner, or say the goal is still undefined.",
      },
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Leave the Apartment More",
      titleAliases: [
        "Walk around the block",
        "Small movement goal",
        "Leave apartment more",
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
