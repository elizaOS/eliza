/**
 * Habits: completion at 10pm SFO is recorded as one entry — but if the user
 * then travels to NYC and triggers another completion at midnight local
 * (which is 9pm SFO), the habit must NOT double-count. The day-bucket should
 * follow the home timezone or the user's current timezone consistently.
 *
 * This scenario seeds two completion attempts spanning the timezone shift
 * and verifies that the habit's streakCount increments by 1 — not 2 — for
 * the same logical day.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { updateLifeOpsMeetingPreferences } from "../../../plugins/app-lifeops/src/lifeops/owner-profile.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";

const PACIFIC_TZ = "America/Los_Angeles";
const HABIT_TITLE = "Stretch";
const DEFINITION_ID = "seed-def-stretch-tz-drift";
const OCC_A = "seed-occ-stretch-tz-drift-a";
const OCC_B = "seed-occ-stretch-tz-drift-b";

// 22:00 Pacific Mon Nov 3 = 06:00Z Tue Nov 4 (PST)
const COMPLETION_A_UTC = "2025-11-04T06:00:00.000Z";
// 1 hour later (so still Mon Nov 3 23:00 PT). Local NYC would have been
// 02:00 Tue, but the bucket day must follow user's home TZ.
const COMPLETION_B_UTC = "2025-11-04T07:00:00.000Z";

export default scenario({
  id: "habits.timezone-drift-during-travel",
  title: "Cross-TZ same-day completion does not double-count",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "streak", "timezone", "travel"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits TZ Drift Travel",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "set-tz-pacific",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const ok = await updateLifeOpsMeetingPreferences(runtime, {
          timeZone: PACIFIC_TZ,
        });
        return ok ? undefined : "tz update failed";
      },
    },
    {
      type: "custom",
      name: "seed-two-completions-same-pt-day",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO life_task_definitions (
             id, agent_id, subject_id, kind, title, created_at, updated_at
           ) VALUES (
             ${sqlQuote(DEFINITION_ID)},
             ${sqlQuote(agentId)},
             ${sqlQuote(agentId)},
             'habit',
             ${sqlQuote(HABIT_TITLE)},
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)}
           )`,
        );
        for (const [id, completedAt] of [
          [OCC_A, COMPLETION_A_UTC],
          [OCC_B, COMPLETION_B_UTC],
        ] as const) {
          const relevanceEnd = new Date(
            Date.parse(completedAt) + 5 * 60_000,
          ).toISOString();
          await executeRawSql(
            runtime,
            `INSERT INTO life_task_occurrences (
               id, agent_id, subject_id, definition_id, occurrence_key, due_at,
               relevance_start_at, relevance_end_at, state, completed_at, created_at, updated_at
             ) VALUES (
               ${sqlQuote(id)},
               ${sqlQuote(agentId)},
               ${sqlQuote(agentId)},
               ${sqlQuote(DEFINITION_ID)},
               ${sqlQuote(`seed:${id}`)},
               ${sqlQuote(completedAt)},
               ${sqlQuote(completedAt)},
               ${sqlQuote(relevanceEnd)},
               'completed',
               ${sqlQuote(completedAt)},
               ${sqlQuote(nowIso)},
               ${sqlQuote(nowIso)}
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
      name: "ask-streak",
      text: "How am I doing on stretch this week?",
      expectedActions: ["CHECKIN"],
      timeoutMs: 120_000,
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
      name: "single-day-not-double-counted",
      predicate: (ctx: ScenarioContext) => {
        const action = ctx.actionsCalled.find(
          (a) => a.actionName === "CHECKIN",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                habitSummaries?: Array<{
                  title?: string;
                  streakCount?: number;
                }>;
              })
            : null;
        if (!data) return "expected CHECKIN structured data";
        const stretch = data.habitSummaries?.find(
          (h) => (h.title ?? "").toLowerCase() === HABIT_TITLE.toLowerCase(),
        );
        if (!stretch) return `expected ${HABIT_TITLE} in habitSummaries`;
        if ((stretch.streakCount ?? 0) > 1) {
          return `expected streakCount === 1 (two completions same local day = 1 day credit), got ${stretch.streakCount}`;
        }
        return undefined;
      },
    },
  ],
});
