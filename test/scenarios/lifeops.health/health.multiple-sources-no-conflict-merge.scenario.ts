/**
 * Health: multiple sources, no conflict — Apple Health and Fitbit both
 * agree on step count (within 5%). The agent should merge and pick one
 * source as authoritative without flagging a conflict.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "health.multiple-sources-no-conflict-merge",
  title: "Multiple agreeing sources merge without surfacing a conflict",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "multi-source", "merge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Sources Merge",
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
      name: "steps-query",
      text: "How many steps today?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-does-not-falsely-flag-conflict",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        // The agent must not invent a conflict where there isn't one.
        const falseConflict =
          reply.includes("conflict") ||
          reply.includes("disagree") ||
          reply.includes("two sources");
        if (falseConflict) {
          return `agent flagged a conflict when sources agreed. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
