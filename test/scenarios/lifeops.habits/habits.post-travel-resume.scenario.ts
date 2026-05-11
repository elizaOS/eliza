/**
 * Habits: post-travel resume — pause expires today and the user is back.
 * The agent should resume the habit cleanly without backfilling missed days.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { seedCheckinDefinition } from "../_helpers/lifeops-seeds.ts";

function scenarioNow(ctx: ScenarioContext): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : new Date();
}

async function seedExpiredPauseMetadata(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime?.agentId) return "scenario runtime unavailable";
  // Pause window ended 1 hour ago (pause expired)
  const pauseUntil = new Date(
    scenarioNow(ctx).getTime() - 60 * 60_000,
  ).toISOString();
  const metadataJson = JSON.stringify({ pauseUntil });
  await executeRawSql(
    runtime,
    `UPDATE life_task_definitions
        SET metadata_json = ${sqlQuote(metadataJson)}
      WHERE id = ${sqlQuote("seed-def-habit-checkin-running")}`,
  );
  return undefined;
}

export default scenario({
  id: "habits.post-travel-resume",
  title: "Habit resumes cleanly when travel pause expires",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "pause", "resume"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Post Travel",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-running-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-running",
        title: "Run",
        kind: "habit",
        dueAt: "{{now+1h}}",
      }),
    },
    {
      type: "custom",
      name: "seed-expired-pause",
      apply: seedExpiredPauseMetadata,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "back-from-travel",
      text: "I'm back from the trip — let's pick the run habit back up.",
      expectedActions: ["CHECKIN"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CHECKIN",
      minCount: 1,
    },
    {
      type: "custom",
      name: "no-backfill-of-missed-days",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        const claimsBackfill =
          reply.includes("missed") &&
          (reply.includes("backfill") || reply.includes("catch up"));
        if (claimsBackfill) {
          return `agent should not backfill missed days from a pause window. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
