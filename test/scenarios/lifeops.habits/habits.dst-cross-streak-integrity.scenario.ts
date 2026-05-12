/**
 * Habits: streak survives DST fall-back — the local "day" on the
 * transition Sunday has 25 hours. The habit completion logged before
 * the transition must still credit the local day.
 *
 * This mirrors the existing midnight-tz scenario but for DST fall-back
 * rather than ordinary midnight. America/Los_Angeles falls back to
 * standard time on 2025-11-02 at 02:00 local (PDT -> PST). A 23:30
 * completion on 2025-11-01 should still count as 2025-11-01, not 2025-11-02.
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
// 2025-11-01 23:30 PDT = 2025-11-02 06:30Z (pre fall-back; PDT is UTC-7).
const COMPLETION_AT_UTC = "2025-11-02T06:30:00.000Z";
const HABIT_TITLE = "Meditate";
const DEFINITION_ID = "seed-def-meditate-dst";
const OCCURRENCE_ID = "seed-occ-meditate-dst";

export default scenario({
  id: "habits.dst-cross-streak-integrity",
  title: "Streak counter survives DST fall-back transition",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "streak", "dst", "timezone"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Habit DST Fall-Back",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "set-owner-timezone-to-pacific",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const ok = await updateLifeOpsMeetingPreferences(runtime, {
          timeZone: PACIFIC_TZ,
        });
        return ok ? undefined : "failed to set timezone";
      },
    },
    {
      type: "custom",
      name: "seed-meditate-completion-pre-dst",
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
        const completedAt = COMPLETION_AT_UTC;
        const relevanceEnd = new Date(
          Date.parse(completedAt) + 5 * 60_000,
        ).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO life_task_occurrences (
             id, agent_id, subject_id, definition_id, occurrence_key, due_at,
             relevance_start_at, relevance_end_at, state, completed_at, created_at, updated_at
           ) VALUES (
             ${sqlQuote(OCCURRENCE_ID)},
             ${sqlQuote(agentId)},
             ${sqlQuote(agentId)},
             ${sqlQuote(DEFINITION_ID)},
             ${sqlQuote("seed:meditate-2025-11-01-pt")},
             ${sqlQuote(completedAt)},
             ${sqlQuote(completedAt)},
             ${sqlQuote(relevanceEnd)},
             'completed',
             ${sqlQuote(completedAt)},
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-streak",
      text: "What's my meditation streak?",
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
      name: "streak-survives-dst-fall-back",
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
                  missedOccurrenceStreak?: number;
                }>;
              })
            : null;
        if (!data) return "expected structured check-in data";
        const meditate = data.habitSummaries?.find(
          (h) => (h.title ?? "").toLowerCase() === HABIT_TITLE.toLowerCase(),
        );
        if (!meditate) return `expected ${HABIT_TITLE} in habitSummaries`;
        if ((meditate.streakCount ?? 0) < 1) {
          return `expected streakCount >= 1 for pre-DST completion, got ${meditate.streakCount}`;
        }
        return undefined;
      },
    },
  ],
});
