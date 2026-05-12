/**
 * Sleep: nap and night sleep both logged on the same day — Apple Health
 * records a 30-minute afternoon nap AND a 7-hour night sleep. The agent
 * should disambiguate when the user asks "how much did I sleep last night?"
 * — only the main sleep should be summed.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const NIGHT_START_UTC = "2025-11-04T05:00:00.000Z"; // 22:00 Pacific Mon Nov 3
const NAP_START_UTC = "2025-11-03T22:00:00.000Z"; // 14:00 Pacific Mon Nov 3
const NIGHT_DURATION_SEC = 7 * 3600;
const NAP_DURATION_SEC = 30 * 60;

export default scenario({
  id: "sleep.nap-night-disambiguation",
  title: "Nap vs night sleep — agent disambiguates main sleep",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "disambiguation", "nap"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Sleep Nap vs Night",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-nap-and-night",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();

        // Afternoon nap (is_main_sleep = false)
        const napEnd = new Date(
          Date.parse(NAP_START_UTC) + NAP_DURATION_SEC * 1000,
        ).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_health_sleep_episodes (
             id, agent_id, provider, grant_id, source_external_id,
             local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
             duration_seconds, time_in_bed_seconds, efficiency,
             stage_samples_json, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-nap-2025-11-03")},
             ${sqlQuote(agentId)},
             'apple_health',
             'seed-apple-grant',
             'seed-apple-nap',
             '2025-11-03',
             'America/Los_Angeles',
             ${sqlQuote(NAP_START_UTC)},
             ${sqlQuote(napEnd)},
             FALSE,
             'asleepCore',
             ${NAP_DURATION_SEC},
             ${NAP_DURATION_SEC + 60},
             0.85,
             '[]', '{}',
             ${sqlQuote(nowIso)}, ${sqlQuote(nowIso)}
           )`,
        );

        // Night sleep (is_main_sleep = true)
        const nightEnd = new Date(
          Date.parse(NIGHT_START_UTC) + NIGHT_DURATION_SEC * 1000,
        ).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_health_sleep_episodes (
             id, agent_id, provider, grant_id, source_external_id,
             local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
             duration_seconds, time_in_bed_seconds, efficiency,
             stage_samples_json, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-night-2025-11-03")},
             ${sqlQuote(agentId)},
             'apple_health',
             'seed-apple-grant',
             'seed-apple-night',
             '2025-11-03',
             'America/Los_Angeles',
             ${sqlQuote(NIGHT_START_UTC)},
             ${sqlQuote(nightEnd)},
             TRUE,
             'asleepCore',
             ${NIGHT_DURATION_SEC},
             ${NIGHT_DURATION_SEC + 600},
             0.92,
             '[]', '{}',
             ${sqlQuote(nowIso)}, ${sqlQuote(nowIso)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-night-sleep",
      text: "How much did I sleep last night?",
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
      name: "reports-night-not-7-5",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        // 7h is the night sleep; 7.5h would be the buggy sum with nap
        if (reply.includes("7.5") || reply.includes("7 and a half")) {
          return `agent summed nap into night sleep total. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
    judgeRubric({
      name: "nap-night-disambiguation-rubric",
      threshold: 0.6,
      description:
        "The user has TWO sleep records yesterday: a 30-minute nap and a 7-hour night sleep. They asked 'how much did I sleep last night'. A correct reply reports ~7 hours (the night sleep), optionally mentions the nap. An incorrect reply sums them into 7.5 hours or fails to disambiguate. Score 0 if the reply gives 7.5h as the answer.",
    }),
  ],
});
