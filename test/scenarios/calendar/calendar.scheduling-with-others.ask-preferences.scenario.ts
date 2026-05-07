import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

const SAVED_MEETING_PREFERENCES = {
  preferredStartLocal: "10:00",
  preferredEndLocal: "16:00",
  defaultDurationMinutes: 30,
  travelBufferMinutes: 20,
  blackoutWindows: [
    {
      label: "Lunch",
      startLocal: "12:30",
      endLocal: "13:30",
    },
  ],
} as const;

export default scenario({
  id: "calendar.scheduling-with-others.ask-preferences",
  title: "Agent pulls user's preferred meeting times when asked",
  domain: "calendar",
  tags: ["lifeops", "calendar", "preferences"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-meeting-preferences",
      apply: seedMeetingPreferences(SAVED_MEETING_PREFERENCES),
    },
    {
      type: "custom",
      name: "seed-empty-calendar-cache",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Ask Preferences",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-what-times-to-offer",
      text: "What meeting times should I offer next week based on my saved preferences?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "meeting preference aware slot proposal",
      }),
      responseIncludesAny: ["offer", "slot", "next week", "30"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "CALENDAR",
    },
    {
      type: "custom",
      name: "meeting-preferences-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "meeting preference aware slot proposal",
      }),
    },
    {
      type: "custom",
      name: "meeting-preferences-seeded-window-used",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "CALENDAR",
        );
        if (!hit) {
          return "expected PROPOSE_MEETING_TIMES action result";
        }
        const data = (hit.result?.data ?? {}) as {
          preferences?: {
            preferredStartLocal?: string;
            preferredEndLocal?: string;
            defaultDurationMinutes?: number;
          };
        };
        if (data.preferences?.preferredStartLocal !== "10:00") {
          return "expected saved preferredStartLocal 10:00 in result payload";
        }
        if (data.preferences?.preferredEndLocal !== "16:00") {
          return "expected saved preferredEndLocal 16:00 in result payload";
        }
        if (data.preferences?.defaultDurationMinutes !== 30) {
          return "expected saved defaultDurationMinutes 30 in result payload";
        }
        return undefined;
      },
    },
  ],
});
