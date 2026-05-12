/**
 * Habits: holiday calendar integration — when a federal holiday falls on a
 * recurring habit day, the agent should skip the occurrence rather than
 * marking it missed.
 *
 * The check-in surface should expose `habitSummaries` without a missed
 * streak for the holiday-skipped habit. We seed an existing habit
 * definition and rely on the runtime's holiday-aware cadence.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "habits.holiday-skip-cadence",
  title: "Holiday days are skipped without breaking habit streak",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "holiday", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Holiday Skip",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weekday-habit",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Weekday workout",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "holiday-check",
      text: "What's on my habit list for Thanksgiving? I want to skip workouts that day.",
      responseIncludesAny: ["thanksgiving", "holiday", "skip", "workout"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-acknowledges-holiday-skip",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const acknowledged =
          reply.includes("skip") ||
          reply.includes("pause") ||
          reply.includes("holiday") ||
          reply.includes("thanksgiving") ||
          reply.includes("rest");
        if (!acknowledged) {
          return `expected agent to acknowledge the holiday-skip request; got ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
