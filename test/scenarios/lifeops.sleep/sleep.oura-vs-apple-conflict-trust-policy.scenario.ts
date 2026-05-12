/**
 * Sleep: Oura vs Apple Health conflict, with an explicit trust policy in
 * the owner profile that prefers Oura. The agent should pick Oura's value
 * AND surface the disagreement, without averaging.
 *
 * Differs from the existing apple-vs-oura scenario: that one verifies the
 * agent surfaces both providers without enforcing a resolution. This one
 * verifies the trust policy is respected.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

const NIGHT_START_UTC = "2025-11-04T05:00:00.000Z";
const APPLE_DURATION_SEC = 7 * 3600;
const OURA_DURATION_SEC = 8 * 3600;

export default scenario({
  id: "sleep.oura-vs-apple-conflict-trust-policy",
  title: "Oura preferred over Apple Health when trust policy is set",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "multi-source", "trust-policy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Sleep Trust Policy Oura First",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-apple-and-oura",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        const appleEnd = new Date(
          Date.parse(NIGHT_START_UTC) + APPLE_DURATION_SEC * 1000,
        ).toISOString();
        const ouraEnd = new Date(
          Date.parse(NIGHT_START_UTC) + OURA_DURATION_SEC * 1000,
        ).toISOString();

        for (const [id, provider, dur, end] of [
          ["seed-apple-trust", "apple_health", APPLE_DURATION_SEC, appleEnd],
          ["seed-oura-trust", "oura", OURA_DURATION_SEC, ouraEnd],
        ] as const) {
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_health_sleep_episodes (
               id, agent_id, provider, grant_id, source_external_id,
               local_date, timezone, start_at, end_at, is_main_sleep, sleep_type,
               duration_seconds, time_in_bed_seconds, efficiency,
               stage_samples_json, metadata_json, created_at, updated_at
             ) VALUES (
               ${sqlQuote(id)},
               ${sqlQuote(agentId)},
               ${sqlQuote(provider)},
               'seed-grant',
               ${sqlQuote(`${id}-ext`)},
               '2025-11-03',
               'America/Los_Angeles',
               ${sqlQuote(NIGHT_START_UTC)},
               ${sqlQuote(end)},
               TRUE,
               ${provider === "oura" ? "'long_sleep'" : "'asleepCore'"},
               ${dur},
               ${dur + 600},
               ${provider === "oura" ? 0.94 : 0.91},
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
      name: "sleep-query-trust-oura",
      text: "I trust Oura more than Apple Health. How much did I sleep last night?",
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
      name: "agent-prefers-oura-when-asked",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const has8h =
          reply.includes("8h") ||
          reply.includes("8 h") ||
          reply.includes("8 hour") ||
          reply.includes("eight hour");
        const hasOura = reply.includes("oura");
        if (!has8h || !hasOura) {
          return `agent should pick the Oura (8h) value when user asks. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
