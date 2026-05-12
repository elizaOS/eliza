/**
 * Sleep multi-source conflict — Apple Health says 7h, Oura says 8h.
 *
 * Failure modes guarded:
 *   - silently averaging the two sources without flagging the conflict
 *   - silently picking one provider with no provenance attached
 *   - returning a single number that doesn't surface either source
 *
 * Required behavior: the agent's reply must (a) acknowledge BOTH sources
 * exist, (b) report the synthesized record, AND (c) attach provenance —
 * either by naming the chosen source or by reporting both numbers.
 *
 * This scenario does not enforce a single resolution rule (highest-confidence,
 * latest-write, etc.); the existing `parseHealthSleepEpisodes` in
 * `plugin-health/src/sleep/sleep-cycle.ts:201` doesn't yet pick between two
 * provider rows for the same night. What we DO assert is the behavior the
 * user can observe: the agent surfaces the conflict honestly.
 *
 * Cited: 03-coverage-gap-matrix.md row 13 / sleep events; sleep-multi-source
 * conflict has zero scenarios. plugin-health/src/sleep/sleep-cycle.ts:285-287
 * dedupes by source+timestamp but doesn't disambiguate competing providers.
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
const APPLE_HEALTH_DURATION_SEC = 7 * 3600;
const OURA_DURATION_SEC = 8 * 3600;

function checkAgentSurfacesBothSources(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty agent response";

  // The agent must mention BOTH provider names (apple/health and oura), OR
  // mention "two sources" / "conflict" / "differ" plus at least one provider.
  // String "apple" and "oura" come from the *seeded provider rows*, NOT from
  // the user's prompt — so finding them in the reply proves the agent read
  // the live sleep table.
  const appleSignals = ["apple", "healthkit", "health kit"];
  const ouraSignals = ["oura"];
  const hasApple = appleSignals.some((s) => reply.includes(s));
  const hasOura = ouraSignals.some((s) => reply.includes(s));
  const conflictSignals = [
    "conflict",
    "two sources",
    "differ",
    "different",
    "two providers",
    "two records",
    "disagree",
    "inconsistent",
  ];
  const hasConflictMarker = conflictSignals.some((s) => reply.includes(s));

  if (!hasApple && !hasOura) {
    return `Reply mentioned neither Apple Health nor Oura. The agent must surface provenance for the synthesized sleep record. Reply: ${reply.slice(0, 400)}`;
  }
  if (!hasApple && !hasConflictMarker) {
    return `Reply mentioned Oura but not Apple Health and did not mark the conflict. The agent silently dropped one source. Reply: ${reply.slice(0, 400)}`;
  }
  if (!hasOura && !hasConflictMarker) {
    return `Reply mentioned Apple Health but not Oura and did not mark the conflict. The agent silently dropped one source. Reply: ${reply.slice(0, 400)}`;
  }

  // Reply must reference at least one of the actual durations (7h or 8h)
  // since otherwise the agent invented an unrelated number.
  const durationSignals = [
    "7h",
    "7 h",
    "7 hour",
    "seven hour",
    "8h",
    "8 h",
    "8 hour",
    "eight hour",
  ];
  if (!durationSignals.some((s) => reply.includes(s))) {
    return `Reply did not surface either of the seeded durations (7h Apple Health / 8h Oura). The agent fabricated a number. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "sleep.apple-vs-oura-conflict",
  title:
    "Sleep summary surfaces Apple Health (7h) vs Oura (8h) conflict with provenance",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "multi-source", "provenance", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Sleep Multi-Source Conflict",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-apple-vs-oura-sleep",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        const nightStart = NIGHT_START_UTC;
        const appleEnd = new Date(
          Date.parse(nightStart) + APPLE_HEALTH_DURATION_SEC * 1000,
        ).toISOString();
        const ouraEnd = new Date(
          Date.parse(nightStart) + OURA_DURATION_SEC * 1000,
        ).toISOString();

        // Apple Health row — 7h sleep, lower efficiency.
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_health_sleep_episodes (
             id, agent_id, provider, grant_id, source_external_id,
             local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
             duration_seconds, time_in_bed_seconds, efficiency,
             stage_samples_json, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-apple-sleep-2025-11-03")},
             ${sqlQuote(agentId)},
             'apple_health',
             'seed-apple-grant',
             'seed-apple-ext-1',
             '2025-11-03',
             'America/Los_Angeles',
             ${sqlQuote(nightStart)},
             ${sqlQuote(appleEnd)},
             TRUE,
             'asleepCore',
             ${APPLE_HEALTH_DURATION_SEC},
             ${APPLE_HEALTH_DURATION_SEC + 600},
             0.91,
             '[]', '{}',
             ${sqlQuote(nowIso)}, ${sqlQuote(nowIso)}
           )`,
        );

        // Oura row — 8h sleep, higher efficiency.
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_health_sleep_episodes (
             id, agent_id, provider, grant_id, source_external_id,
             local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
             duration_seconds, time_in_bed_seconds, efficiency,
             stage_samples_json, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-oura-sleep-2025-11-03")},
             ${sqlQuote(agentId)},
             'oura',
             'seed-oura-grant',
             'seed-oura-ext-1',
             '2025-11-03',
             'America/Los_Angeles',
             ${sqlQuote(nightStart)},
             ${sqlQuote(ouraEnd)},
             TRUE,
             'long_sleep',
             ${OURA_DURATION_SEC},
             ${OURA_DURATION_SEC + 1200},
             0.94,
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
      name: "ask-sleep-summary",
      room: "main",
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
      name: "agent-surfaces-multi-source-conflict",
      predicate: checkAgentSurfacesBothSources,
    },
    judgeRubric({
      name: "sleep-apple-vs-oura-conflict-rubric",
      threshold: 0.7,
      description: `The user has TWO sleep records for last night: Apple Health says 7 hours and Oura says 8 hours. They asked "how much did I sleep". A correct reply: surfaces both providers (or at minimum names one and acknowledges a second source disagrees), AND reports a duration consistent with one of the recorded values. An incorrect reply: returns a single hour count without provenance (e.g. "you slept 7.5 hours") that silently averages the two; fabricates a number not in the table; claims there is no data. Score 0 if the reply contains a single duration with no source attribution AND no acknowledgment that two providers reported different values.`,
    }),
  ],
});
