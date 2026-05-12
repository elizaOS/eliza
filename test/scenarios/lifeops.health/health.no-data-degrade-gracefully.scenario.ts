/**
 * Health: no data available — user has not connected HealthKit / Oura /
 * Fitbit. The agent should NOT fabricate numbers; it should report no data
 * and offer to help connect a source.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import type { AgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "health.no-data-degrade-gracefully",
  title: "No health data — agent admits and offers to connect a source",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "no-data", "graceful-degradation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health No Data",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "bootstrap-schema-only",
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
      name: "no-data-query",
      text: "How many steps did I take this week?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-admits-no-data",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        // The agent should NOT invent a step count.
        const inventedNumber = /\b[1-9]\d{2,}\b/.test(reply);
        const admitted =
          reply.includes("no data") ||
          reply.includes("haven't") ||
          reply.includes("don't have") ||
          reply.includes("not connected") ||
          reply.includes("connect");
        if (inventedNumber && !admitted) {
          return `agent appears to have fabricated a step count. Reply: ${reply.slice(0, 300)}`;
        }
        if (!admitted) {
          return `agent should admit no data and offer to connect a source. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
    judgeRubric({
      name: "no-data-graceful-rubric",
      threshold: 0.6,
      description:
        "User asks for step count but no health source is connected. Correct reply: admits no step data is available, offers to help connect HealthKit/Oura/Fitbit. Incorrect reply: fabricates a step count, or gives a confident answer without admitting absence of data. Score 0 if the agent fabricates a number.",
    }),
  ],
});
