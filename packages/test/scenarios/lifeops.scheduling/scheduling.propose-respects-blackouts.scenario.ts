/**
 * Propose-times must respect the user's seeded blackout windows (commute,
 * gym, lunch). Proposed slots cannot overlap any blackout.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkProposedSlotsRespectBlackouts(
  ctx: ScenarioContext,
): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({ p: c.parameters ?? null, d: c.result?.data ?? null })),
  );
  // Scan for clock-time hits in the seeded blackout ranges (07:00-09:00
  // commute, 12:00-13:00 lunch, 18:00-19:30 gym).
  const matches = blob.match(/\b(\d{1,2}):(\d{2})\b/g) ?? [];
  for (const t of matches) {
    const [hStr, mStr] = t.split(":");
    if (!hStr || !mStr) continue;
    const h = Number.parseInt(hStr, 10);
    const m = Number.parseInt(mStr, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    if (h >= 7 && h < 9) {
      return `Proposed ${t} falls inside the 07:00-09:00 commute blackout.`;
    }
    if (h === 12) {
      return `Proposed ${t} falls inside the 12:00-13:00 lunch blackout.`;
    }
    if (h === 18 || (h === 19 && m < 30)) {
      return `Proposed ${t} falls inside the 18:00-19:30 gym blackout.`;
    }
  }
  return undefined;
}

export default scenario({
  id: "scheduling.propose-respects-blackouts",
  title: "Proposed slots avoid commute / lunch / gym blackout windows",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "blackouts"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Blackouts-Respected Proposal",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "20:00",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          { label: "Commute", startLocal: "07:00", endLocal: "09:00" },
          { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
          { label: "Gym", startLocal: "18:00", endLocal: "19:30" },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-empty",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-respecting-blackouts",
      room: "main",
      text: "Give me four 30-minute slots tomorrow for assorted check-ins.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "no-blackout-overlap",
      predicate: checkProposedSlotsRespectBlackouts,
    },
    judgeRubric({
      name: "scheduling-blackouts-rubric",
      threshold: 0.6,
      description: `Three blackouts seeded: 07:00-09:00 commute, 12:00-13:00 lunch, 18:00-19:30 gym. NO proposed slot may overlap. Incorrect: proposes 7:30am, noon, or 6pm slots.`,
    }),
  ],
});
