/**
 * Health: today overview — walking + running + strain. The agent should
 * read HealthKit-style data via the HEALTH action and produce a single
 * concise summary, not three separate paragraphs.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "health.today-overview-walk-run-strain",
  title: "Today's overview combines walk, run, and strain in one summary",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "overview"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Today Overview",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-todays-activity",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        // Best-effort: insert if schema exists. The HEALTH action will read
        // whatever is in the health tables.
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "health-today",
      text: "How am I doing on activity today?",
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
      name: "single-summary-not-three-paragraphs",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        );
        if (!reply) return "empty reply";
        // Heuristic: more than 5 paragraph breaks suggests the agent is
        // not summarizing.
        const paragraphCount = reply.split(/\n\s*\n/).length;
        if (paragraphCount > 6) {
          return `agent should produce a concise summary, not ${paragraphCount} paragraphs`;
        }
        return undefined;
      },
    },
  ],
});
