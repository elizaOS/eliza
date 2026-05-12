/**
 * Sleep: weekly review — goal is 8h sleep average. The user averaged 6h
 * this week. The agent should mark the sleep goal as needs-attention
 * (not at-risk for a single bad week).
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { seedLifeOpsGoal } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "sleep.health-goal-grounding-weekly-review",
  title: "Weekly sleep review marks under-target as needs-attention",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "goals", "review"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Weekly Review",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-sleep-goal",
      apply: seedLifeOpsGoal({ title: "Sleep 8 hours per night" }),
    },
    {
      type: "custom",
      name: "seed-week-of-short-sleep",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        for (let day = 1; day <= 7; day++) {
          // Bedtime each night around 23:00 PT, only 6 hours of sleep
          const start = new Date(
            Date.parse("2025-11-03T07:00:00.000Z") - day * 24 * 3600_000,
          ).toISOString();
          const end = new Date(Date.parse(start) + 6 * 3600_000).toISOString();
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_health_sleep_episodes (
               id, agent_id, provider, grant_id, source_external_id,
               local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
               duration_seconds, time_in_bed_seconds, efficiency,
               stage_samples_json, metadata_json, created_at, updated_at
             ) VALUES (
               ${sqlQuote(`seed-night-${day}`)},
               ${sqlQuote(agentId)},
               'apple_health',
               'seed-apple-grant',
               ${sqlQuote(`seed-apple-night-${day}`)},
               ${sqlQuote(new Date(Date.parse(start)).toISOString().slice(0, 10))},
               'America/Los_Angeles',
               ${sqlQuote(start)},
               ${sqlQuote(end)},
               TRUE,
               'asleepCore',
               ${6 * 3600},
               ${6 * 3600 + 600},
               0.86,
               '[]', '{}',
               ${sqlQuote(nowIso)}, ${sqlQuote(nowIso)}
             )`,
          );
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekly-review",
      text: "How am I doing on my sleep goal this week?",
      expectedActions: ["HEALTH", "CHECKIN"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-flags-sleep-goal-attention",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        const flagged =
          reply.includes("short") ||
          reply.includes("under") ||
          reply.includes("6") ||
          reply.includes("less than") ||
          reply.includes("missing") ||
          reply.includes("below");
        if (!flagged) {
          return `agent should acknowledge sleep is under the 8h goal. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
