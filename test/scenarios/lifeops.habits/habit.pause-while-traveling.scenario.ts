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

async function seedPauseMetadata(ctx: {
  runtime?: unknown;
  now?: string | Date;
}): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime?.agentId) {
    return "scenario runtime unavailable";
  }

  const pauseUntil = new Date(
    scenarioNow(ctx).getTime() + 6 * 60 * 60 * 1000,
  ).toISOString();
  const metadataJson = JSON.stringify({ pauseUntil });

  await executeRawSql(
    runtime,
    `UPDATE life_task_definitions
        SET metadata_json = ${sqlQuote(metadataJson)}
      WHERE id = ${sqlQuote("seed-def-habit-checkin-stretch")}`,
  );

  return undefined;
}

export default scenario({
  id: "habit.pause-while-traveling",
  title: "Morning check-in respects time-bounded habit pauses",
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
      title: "LifeOps Habit Travel Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-paused-stretch-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-stretch",
        title: "Stretch",
        kind: "habit",
        dueAt: "{{now-2h}}",
      }),
    },
    {
      type: "custom",
      name: "seed-habit-pause-window",
      apply: seedPauseMetadata,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "travel-reschedule-request",
      text: "Run my morning check-in.",
      expectedActions: ["CHECKIN"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "habit-pause-is-reflected",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "CHECKIN",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                habitEscalationLevel?: number;
                overdueTodos?: Array<{ title?: string }>;
                habitSummaries?: Array<{
                  title?: string;
                  pauseUntil?: string | null;
                  isPaused?: boolean;
                }>;
              })
            : null;
        if (!data) {
          return "expected structured check-in data";
        }
        if (data.habitEscalationLevel !== 0) {
          return `expected habitEscalationLevel 0 while paused, got ${data.habitEscalationLevel ?? "(missing)"}`;
        }
        const stretch = data.habitSummaries?.find(
          (habit) => habit.title === "Stretch",
        );
        if (!stretch) {
          return "expected Stretch in habitSummaries";
        }
        if (stretch.isPaused !== true) {
          return "expected Stretch to be paused";
        }
        if (!stretch.pauseUntil) {
          return "expected pauseUntil on Stretch";
        }
        const pauseUntilMs = Date.parse(stretch.pauseUntil);
        if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= Date.now()) {
          return `expected pauseUntil to be in the future, got ${stretch.pauseUntil}`;
        }
        if (data.overdueTodos?.some((todo) => todo.title === "Stretch")) {
          return "expected paused Stretch to be excluded from overdue todos";
        }
        return undefined;
      },
    },
  ],
});
