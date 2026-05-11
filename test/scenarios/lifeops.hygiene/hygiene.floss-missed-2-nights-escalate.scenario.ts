/**
 * Hygiene: 2 missed flossing nights — CHECKIN must surface escalation level
 * and the agent should bring it up in the morning brief without lecturing.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import type { IAgentRuntime } from "@elizaos/core";
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

async function seedSecondMissedFloss(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime?.agentId) return "scenario runtime unavailable";
  const now = scenarioNow(ctx);
  const agentId = String(runtime.agentId);
  const dueAt = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
  const createdAt = new Date(
    now.getTime() - 30 * 60 * 60 * 1000,
  ).toISOString();

  await executeRawSql(
    runtime,
    `INSERT INTO life_task_occurrences (
       id, agent_id, subject_id, definition_id, occurrence_key, due_at,
       relevance_start_at, relevance_end_at, state, created_at, updated_at
     ) VALUES (
       ${sqlQuote("habit-checkin-floss-2")},
       ${sqlQuote(agentId)},
       ${sqlQuote(agentId)},
       ${sqlQuote("seed-def-habit-checkin-floss")},
       ${sqlQuote("seed:habit-checkin-floss-2")},
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
  id: "hygiene.floss-missed-2-nights-escalate",
  title: "Floss escalation surfaces after 2 missed nights",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "escalation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Floss Escalation",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-floss-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-floss",
        title: "Floss",
        kind: "habit",
        dueAt: "{{now-2h}}",
      }),
    },
    {
      type: "custom",
      name: "seed-second-missed-floss",
      apply: seedSecondMissedFloss,
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
    {
      type: "custom",
      name: "floss-escalation-surfaced",
      predicate: (ctx) => {
        const action = ctx.actionsCalled.find(
          (a) => a.actionName === "CHECKIN",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                habitEscalationLevel?: number;
                habitSummaries?: Array<{
                  title?: string;
                  missedOccurrenceStreak?: number;
                }>;
              })
            : null;
        if (!data) return "expected structured check-in data";
        if ((data.habitEscalationLevel ?? 0) < 2) {
          return `expected habitEscalationLevel >= 2 for 2 missed nights, got ${data.habitEscalationLevel}`;
        }
        const floss = data.habitSummaries?.find((h) => h.title === "Floss");
        if (!floss) return "expected Floss in habitSummaries";
        if ((floss.missedOccurrenceStreak ?? 0) < 2) {
          return `expected missed streak >= 2 for Floss, got ${floss.missedOccurrenceStreak}`;
        }
        return undefined;
      },
    },
  ],
});
