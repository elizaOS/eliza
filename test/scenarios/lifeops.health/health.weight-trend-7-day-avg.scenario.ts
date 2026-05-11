/**
 * Health: weight trend — user asks for their weight trend, the agent
 * should use a 7-day average rather than yesterday's spot reading.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import type { AgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "health.weight-trend-7-day-avg",
  title: "Weight trend uses 7-day average, not a single reading",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "weight", "trend"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Weight Trend",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "bootstrap-schema",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weight-trend",
      text: "What's my weight trend over the last week?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-uses-trend-not-single-reading",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const trendish =
          reply.includes("trend") ||
          reply.includes("average") ||
          reply.includes("week") ||
          reply.includes("don't have") ||
          reply.includes("no data") ||
          reply.includes("haven't");
        if (!trendish) {
          return `agent should respond with a trend or admit no data. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
