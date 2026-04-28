import { scenario } from "@elizaos/scenario-schema";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";
import { seedLifeOpsGoal } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "goal.career.quarterly-review",
  title: "Quarterly review now asserts current review_goal semantics",
  domain: "goals",
  tags: ["lifeops", "goals", "career", "smoke"],
  description:
    "This scenario exercises the current review_goal path on a seeded career goal and asserts the structured review summary that the runtime returns today.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-quarterly-career-goal",
      apply: seedLifeOpsGoal({
        title: "Quarterly career goal",
      }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Career Goal Review",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "review-goal",
      text: "Review my Quarterly career goal.",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "no linked support tasks or routines yet",
        "nothing concrete to keep it moving",
      ],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "quarterly-review-returns-structured-review_goal-data",
      predicate: expectScenarioActionResultData({
        description: "structured review_goal payload",
        actionName: "LIFE",
        includesAll: [
          '"linkedDefinitionCount":0',
          '"activeOccurrenceCount":0',
          '"overdueOccurrenceCount":0',
          '"completedLast7Days":0',
          '"reviewState":"needs_attention"',
        ],
      }),
    },
    {
      type: "custom",
      name: "quarterly-review-uses-the-current-review-explanation",
      predicate: async (ctx) => {
        const reply = ctx.turns?.[0]?.responseText ?? "";
        const lower = reply.toLowerCase();
        return lower.includes("no linked support tasks or routines yet") &&
          lower.includes("nothing concrete to keep it moving")
          ? undefined
          : `expected the current review_goal explanation, got: ${reply}`;
      },
    },
  ],
});
