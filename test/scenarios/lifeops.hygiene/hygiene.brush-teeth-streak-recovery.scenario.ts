/**
 * Hygiene: streak recovery for brushing teeth — user has 2 missed mornings.
 * The CHECKIN action should surface the missed streak and offer a friendly
 * recovery path without shaming the user.
 *
 * Bug class guarded: the agent moralizes about missed brushing instead of
 * just resetting the streak and getting on with the day.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCheckinDefinition } from "../_helpers/lifeops-seeds.ts";

function scenarioNow(ctx: ScenarioContext): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : new Date();
}

async function seedSecondMissedBrushOccurrence(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime?.agentId) return "scenario runtime unavailable";
  const now = scenarioNow(ctx);
  const agentId = String(runtime.agentId);
  const dueAt = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
  const createdAt = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();

  await executeRawSql(
    runtime,
    `INSERT INTO life_task_occurrences (
       id, agent_id, subject_id, definition_id, occurrence_key, due_at,
       relevance_start_at, relevance_end_at, state, created_at, updated_at
     ) VALUES (
       ${sqlQuote("habit-checkin-brush-2")},
       ${sqlQuote(agentId)},
       ${sqlQuote(agentId)},
       ${sqlQuote("seed-def-habit-checkin-brush")},
       ${sqlQuote("seed:habit-checkin-brush-2")},
       ${sqlQuote(dueAt)},
       ${sqlQuote(dueAt)},
       ${sqlQuote(new Date(Date.parse(dueAt) + 6 * 60 * 60 * 1000).toISOString())},
       'pending',
       ${sqlQuote(createdAt)},
       ${sqlQuote(createdAt)}
     )`,
  );
  return undefined;
}

export default scenario({
  id: "hygiene.brush-teeth-streak-recovery",
  title: "Brushing streak recovery surfaces missed days with a warm tone",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "streak"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Brush Recovery",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-brush-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-brush",
        title: "Brush teeth",
        kind: "habit",
        dueAt: "{{now-2h}}",
      }),
    },
    {
      type: "custom",
      name: "seed-second-missed-brush",
      apply: seedSecondMissedBrushOccurrence,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-checkin",
      text: "Run my morning check-in.",
      expectedActions: ["CHECKIN"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CHECKIN",
      minCount: 1,
    },
    judgeRubric({
      name: "brush-streak-recovery-warm-tone",
      threshold: 0.6,
      description:
        "The check-in should mention the missed brushing days briefly and offer to reset the streak or just get back on track today. It must NOT moralize, lecture, or guilt-trip the user about dental hygiene. Score 1 if the reply is matter-of-fact and forward-looking; score 0 if it lectures about cavities or tells the user they should be ashamed.",
    }),
  ],
});
