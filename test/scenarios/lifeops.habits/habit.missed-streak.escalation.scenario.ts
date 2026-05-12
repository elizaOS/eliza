import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { seedCheckinDefinition } from "../_helpers/lifeops-seeds.ts";

function scenarioNow(ctx: { now?: string | Date }): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : ctx.now instanceof Date
      ? ctx.now
      : new Date();
}

async function seedSecondMissedOccurrence(ctx: {
  runtime?: unknown;
  now?: string | Date;
}): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime?.agentId) {
    return "scenario runtime unavailable";
  }

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
       ${sqlQuote("habit-checkin-stretch-2")},
       ${sqlQuote(agentId)},
       ${sqlQuote(agentId)},
       ${sqlQuote("seed-def-habit-checkin-stretch")},
       ${sqlQuote("seed:habit-checkin-stretch-2")},
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
  id: "habit.missed-streak.escalation",
  title: "Morning check-in exposes missed-streak escalation",
  domain: "habits",
  tags: ["lifeops", "habits", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habit Morning Check-in",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-stretch-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-stretch",
        title: "Stretch",
        kind: "habit",
        dueAt: "{{now-2h}}",
      }),
    },
    {
      type: "custom",
      name: "seed-second-missed-stretch",
      apply: seedSecondMissedOccurrence,
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
      type: "custom",
      name: "morning-checkin-report-includes-missed-streak",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "CHECKIN",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                habitEscalationLevel?: number;
                habitSummaries?: Array<{
                  title?: string;
                  missedOccurrenceStreak?: number;
                  isPaused?: boolean;
                }>;
              })
            : null;
        if (!data) {
          return "expected structured check-in data";
        }
        if (data.habitEscalationLevel !== 2) {
          return `expected habitEscalationLevel 2, got ${data.habitEscalationLevel ?? "(missing)"}`;
        }
        const stretch = data.habitSummaries?.find(
          (habit) => habit.title === "Stretch",
        );
        if (!stretch) {
          return "expected Stretch in habitSummaries";
        }
        if (stretch.missedOccurrenceStreak !== 2) {
          return `expected missedOccurrenceStreak 2 for Stretch, got ${stretch.missedOccurrenceStreak ?? "(missing)"}`;
        }
        if (stretch.isPaused !== false) {
          return "expected Stretch to be active, not paused";
        }
        return undefined;
      },
    },
  ],
});
