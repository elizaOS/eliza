/**
 * Propose-times honors meeting preferences — no early AM, no late PM, no
 * lunch overlap.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkProposalRespectsPrefs(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({
      parameters: c.parameters ?? null,
      data: c.result?.data ?? null,
      text: c.result?.text ?? null,
    })),
  );
  // Scan for any clock times in the action payload.
  const timeMatches = blob.match(/\b(\d{1,2}):(\d{2})\b/g) ?? [];
  for (const t of timeMatches) {
    const [hStr, mStr] = t.split(":");
    if (!hStr || !mStr) continue;
    const h = Number.parseInt(hStr, 10);
    const m = Number.parseInt(mStr, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    // Skip if it looks like a date or ISO fragment (e.g., 2025).
    if (h >= 0 && h < 9) {
      return `Proposed slot at ${t} violates 09:00 preference floor.`;
    }
    if (h >= 18) {
      return `Proposed slot at ${t} violates 18:00 preference ceiling.`;
    }
    if (h === 12 && m < 60) {
      return `Proposed slot at ${t} falls inside the seeded 12:00-13:00 lunch blackout.`;
    }
  }
  return undefined;
}

export default scenario({
  id: "calendar.propose-times-respect-prefs",
  title: "Proposed slots honor 09:00-18:00 prefs + 12:00-13:00 lunch blackout",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "preferences", "scheduling"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Prefs-Respecting Proposal",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-empty-calendar",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-respecting-prefs",
      room: "main",
      text: "Propose three 30-minute slots for a chat with Dana tomorrow.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "proposals-respect-prefs",
      predicate: checkProposalRespectsPrefs,
    },
    judgeRubric({
      name: "calendar-propose-respect-prefs-rubric",
      threshold: 0.6,
      description: `Preferences: 09:00-18:00 working hours, 12:00-13:00 lunch blackout. Correct: all three proposed slots fall inside 09:00-18:00 AND do not overlap 12:00-13:00. Incorrect: any slot at 8am, after 6pm, or during lunch.`,
    }),
  ],
});
