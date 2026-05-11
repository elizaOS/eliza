/**
 * Health: medication adherence percentage — user asks how often they took
 * meds this month. The agent should compute completed/total occurrences.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "health.medication-adherence-percentage",
  title: "Medication adherence percentage over the past month",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "medication", "adherence"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Med Adherence",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-med-habit",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Take medication",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "adherence-query",
      text: "What percent of the time did I take my meds this month?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-answers-percentage-or-no-data",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const responded =
          /\d+%/.test(reply) ||
          reply.includes("percent") ||
          reply.includes("haven't") ||
          reply.includes("no data") ||
          reply.includes("don't have") ||
          reply.includes("started tracking");
        if (!responded) {
          return `agent should give an adherence percentage or admit no data. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
