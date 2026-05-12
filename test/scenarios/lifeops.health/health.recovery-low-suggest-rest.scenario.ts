/**
 * Health: low recovery score from Oura/Whoop — the agent should suggest
 * easing up on planned workouts rather than push through.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import type { AgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "health.recovery-low-suggest-rest",
  title: "Low recovery score — agent suggests easing the day",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "recovery", "rest"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Low Recovery",
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
      name: "recovery-query",
      text: "My recovery is at 35 today. Should I still do the heavy lift workout I planned?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-suggests-easing",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const sensible =
          reply.includes("ease") ||
          reply.includes("rest") ||
          reply.includes("low") ||
          reply.includes("light") ||
          reply.includes("recover") ||
          reply.includes("skip");
        if (!sensible) {
          return `agent should suggest easing or resting at 35 recovery. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
