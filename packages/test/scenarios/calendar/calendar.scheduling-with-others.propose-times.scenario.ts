import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "calendar.scheduling-with-others.propose-times",
  title: "Agent proposes three available time slots for a meeting",
  domain: "calendar",
  tags: ["lifeops", "calendar", "scheduling"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-meeting-preferences",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:30",
        preferredEndLocal: "16:30",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          {
            label: "Lunch",
            startLocal: "12:00",
            endLocal: "13:00",
          },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-calendar-cache",
      apply: seedCalendarCache({
        events: [
          {
            id: "calendar-propose-standing-sync",
            title: "Standing sync",
            startOffsetMinutes: 24 * 60 + 60,
            durationMinutes: 60,
            attendees: ["owner@example.test"],
          },
          {
            id: "calendar-propose-late-afternoon-review",
            title: "Late afternoon review",
            startOffsetMinutes: 24 * 60 + 6 * 60,
            durationMinutes: 60,
            attendees: ["owner@example.test"],
          },
        ],
      }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Propose Times",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-three-slots",
      text: "Give me three 30-minute slots I can offer Alex next week.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "three meeting slots for Alex",
      }),
      responseIncludesAny: ["three", "slot", "Alex", "30"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "CALENDAR",
    },
    {
      type: "custom",
      name: "meeting-slots-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "three meeting slots for Alex",
      }),
    },
    {
      type: "custom",
      name: "meeting-slots-result-shape",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "CALENDAR",
        );
        if (!hit) {
          return "expected PROPOSE_MEETING_TIMES action result";
        }
        const data = (hit.result?.data ?? {}) as {
          slots?: unknown[];
          durationMinutes?: number;
        };
        if (!Array.isArray(data.slots) || data.slots.length < 3) {
          return "expected at least three proposed slots in action result payload";
        }
        if (data.durationMinutes !== 30) {
          return "expected a 30-minute proposal window";
        }
        return undefined;
      },
    },
  ],
});
