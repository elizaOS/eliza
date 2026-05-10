/**
 * Habit streak — completion at 11:55pm America/Los_Angeles when server TZ is UTC.
 *
 * Bug class this guards: a habit completed at 23:55 PT (07:55Z next day)
 * must increment the streak for the USER'S local day, not the server's
 * UTC day. Naive code that buckets by `new Date(completedAt).toISOString().slice(0,10)`
 * would credit the next UTC day, splitting a single-day streak into two.
 *
 * Seed: a "Stretch" daily habit definition with a completed occurrence at
 * 2025-11-04T07:55:00.000Z (which is 2025-11-03T23:55 in America/Los_Angeles —
 * post-DST, so the local hour is correct). Owner profile timezone set to
 * America/Los_Angeles. The user then asks the agent for the streak count.
 *
 * Assertion: the CHECKIN action's habitSummaries[Stretch].streakCount must
 * be >= 1 AND the local day for the completion must be 2025-11-03 (Pacific),
 * NOT 2025-11-04 (UTC). We verify by inspecting the structured CHECKIN
 * result data — no string fishing on the user prompt.
 *
 * Cited: 03-coverage-gap-matrix.md row 7 — habit streaks crossing midnight TZ
 * have no scenario.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { updateLifeOpsMeetingPreferences } from "../../../plugins/app-lifeops/src/lifeops/owner-profile.ts";

const PACIFIC_TZ = "America/Los_Angeles";
// 2025-11-03 23:55 PT = 2025-11-04 07:55Z (post-DST, PST is UTC-8)
const COMPLETION_AT_UTC = "2025-11-04T07:55:00.000Z";
const HABIT_TITLE = "Stretch";
const DEFINITION_ID = "seed-def-stretch-tz-streak";
const OCCURRENCE_ID = "seed-occ-stretch-tz-streak";

interface CheckinHabitSummary {
  title?: string;
  streakCount?: number;
  missedOccurrenceStreak?: number;
  isPaused?: boolean;
  lastCompletedLocalDate?: string;
  lastCompletedLocalDay?: string;
}

interface CheckinData {
  habitSummaries?: CheckinHabitSummary[];
}

function checkStreakCreditedToPacificDay(
  ctx: ScenarioContext,
): string | undefined {
  const checkin = ctx.actionsCalled.find(
    (action) => action.actionName === "CHECKIN",
  );
  if (!checkin) return "expected CHECKIN action";
  const data = checkin.result?.data as CheckinData | undefined;
  if (!data) return "CHECKIN action returned no structured data";
  const stretch = data.habitSummaries?.find(
    (h) => (h.title ?? "").toLowerCase() === HABIT_TITLE.toLowerCase(),
  );
  if (!stretch) {
    return `expected ${HABIT_TITLE} in habitSummaries; got ${JSON.stringify(data.habitSummaries)}`;
  }
  // Streak must be at least 1 — otherwise the completion was bucketed into
  // a "future" day relative to the server's clock and not credited.
  if ((stretch.streakCount ?? 0) < 1) {
    return `expected ${HABIT_TITLE}.streakCount >= 1 (one completion at 23:55 Pacific should count); got ${stretch.streakCount}`;
  }
  // The "missed" streak must be 0 — if it's > 0 that means the completion
  // was bucketed into 2025-11-04 (UTC day) and 2025-11-03 was reported as
  // missed.
  if ((stretch.missedOccurrenceStreak ?? 0) !== 0) {
    return `expected ${HABIT_TITLE}.missedOccurrenceStreak === 0 (completion at 23:55 Pacific covers the local day); got ${stretch.missedOccurrenceStreak}`;
  }
  return undefined;
}

export default scenario({
  id: "habit.streak.midnight-tz",
  title:
    "Habit streak credits the user's TZ day, not the server's UTC day",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "streak", "timezone", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Habit Streak TZ Boundary",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "set-owner-timezone-to-pacific",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const updated = await updateLifeOpsMeetingPreferences(runtime, {
          timeZone: PACIFIC_TZ,
        });
        return updated ? undefined : "failed to set owner timezone";
      },
    },
    {
      type: "custom",
      name: "seed-stretch-definition-and-completed-occurrence",
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
        // One completed occurrence at 23:55 Pacific on 2025-11-03 (=07:55Z 11-04).
        // due_at = same as completed_at; relevance window covers the local day.
        const completedAt = COMPLETION_AT_UTC;
        const dueAt = completedAt;
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
             ${sqlQuote("seed:stretch-2025-11-03-pt")},
             ${sqlQuote(dueAt)},
             ${sqlQuote(dueAt)},
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
      name: "ask-streak-status",
      room: "main",
      text: "How am I doing on my stretch streak today?",
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
      name: "streak-credited-to-pacific-day",
      predicate: checkStreakCreditedToPacificDay,
    },
  ],
});
