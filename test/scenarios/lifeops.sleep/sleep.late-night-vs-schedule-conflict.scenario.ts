/**
 * Sleep: late-night last night vs early morning meeting scheduled — the
 * agent should surface the conflict between recent sleep debt and a 7am
 * meeting, and offer to reschedule or move the meeting.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

const LATE_BEDTIME_UTC = "2025-11-04T08:00:00.000Z"; // 01:00 Pacific
const SHORT_SLEEP_SEC = 4 * 3600;

export default scenario({
  id: "sleep.late-night-vs-schedule-conflict",
  title: "Late-night sleep + early meeting — agent surfaces conflict",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "conflict", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Late Night Conflict",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-short-sleep",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        const sleepEnd = new Date(
          Date.parse(LATE_BEDTIME_UTC) + SHORT_SLEEP_SEC * 1000,
        ).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_health_sleep_episodes (
             id, agent_id, provider, grant_id, source_external_id,
             local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
             duration_seconds, time_in_bed_seconds, efficiency,
             stage_samples_json, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-short-sleep")},
             ${sqlQuote(agentId)},
             'apple_health',
             'seed-apple-grant',
             'seed-apple-short',
             '2025-11-03',
             'America/Los_Angeles',
             ${sqlQuote(LATE_BEDTIME_UTC)},
             ${sqlQuote(sleepEnd)},
             TRUE,
             'asleepCore',
             ${SHORT_SLEEP_SEC},
             ${SHORT_SLEEP_SEC + 600},
             0.88,
             '[]', '{}',
             ${sqlQuote(nowIso)}, ${sqlQuote(nowIso)}
           )`,
        );
        return undefined;
      },
    },
    {
      type: "custom",
      name: "seed-early-meeting",
      apply: seedCalendarCache({
        events: [
          {
            id: "early-meeting-7am",
            title: "Team standup",
            startOffsetMinutes: 30,
            durationMinutes: 30,
            attendees: ["teammate@example.com"],
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-checkin",
      text: "Quick morning checkin — anything I should know?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-surfaces-sleep-meeting-tension",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        const sleepMention =
          reply.includes("sleep") ||
          reply.includes("rest") ||
          reply.includes("tired") ||
          reply.includes("4 hour");
        if (!sleepMention) {
          return `agent should mention the short sleep. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
