/**
 * Health: weekly step trend — the agent should compare against the prior
 * week and surface whether the trend is up or down.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "health.weekly-step-trend",
  title: "Weekly step trend compares to prior week",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "trend", "steps"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Step Trend",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "bootstrap-health-schema",
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
      name: "weekly-trend",
      text: "Am I walking more or less this week vs last week?",
      expectedActions: ["HEALTH"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "HEALTH",
      minCount: 1,
    },
    {
      type: "custom",
      name: "agent-references-prior-week",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const compared =
          reply.includes("more") ||
          reply.includes("less") ||
          reply.includes("last week") ||
          reply.includes("prior") ||
          reply.includes("compared") ||
          reply.includes("no data") ||
          reply.includes("don't have");
        if (!compared) {
          return `agent should compare to prior week (or admit no data). Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
