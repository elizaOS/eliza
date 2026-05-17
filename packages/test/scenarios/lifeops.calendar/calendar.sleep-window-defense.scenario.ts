/**
 * 7am call attempt against a protected sleep window.
 *
 * Failure mode guarded: the agent silently books a 7am call when the user's
 * sleep window says they sleep 23:00-08:00. The agent must defend the sleep
 * window — either decline, propose alternatives, or explicitly flag the
 * sleep-window override before proceeding.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkSleepWindowSurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "sleep",
    "asleep",
    "wake up",
    "wake-up",
    "too early",
    "morning routine",
    "outside",
    "before 8",
    "before your",
    "8am",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't reference the sleep window when offered a 7am slot. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.sleep-window-defense",
  title:
    "Agent defends a protected 23:00-08:00 sleep window against a 7am call",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "sleep", "time-defense"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Sleep Window Defense",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-sleep-window-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          {
            label: "Sleep",
            startLocal: "23:00",
            endLocal: "08:00",
          },
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
      name: "request-7am-call",
      room: "main",
      text: "Schedule a 30-minute call with the East Coast team tomorrow at 7am my time.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "sleep-window-acknowledged",
      predicate: checkSleepWindowSurfaced,
    },
    judgeRubric({
      name: "calendar-sleep-window-defense-rubric",
      threshold: 0.6,
      description: `User's sleep window is 23:00-08:00 and they asked for a 7am meeting. Correct: agent either refuses, asks for confirmation, or proposes a later time (≥8am). Incorrect: agent silently books at 7am without flagging the sleep window. Score 0 if the agent confirms a 7am booking without acknowledging the window.`,
    }),
  ],
});
