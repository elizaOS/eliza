import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "calendar.defend-time.protects-focus",
  title: "Agent protects calendar focus blocks from meeting requests",
  domain: "calendar",
  tags: ["lifeops", "calendar", "time-defense"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Defend Time Focus",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-focus-block",
      apply: seedCalendarCache({
        events: [
          {
            id: "calendar-focus-block",
            title: "Focus block",
            startOffsetMinutes: 24 * 60 + 90,
            durationMinutes: 120,
            metadata: { category: "focus" },
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-during-focus",
      text: "Add a 30-minute call with Sam tomorrow at 10:30am even though that's during my focus block.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "focus-block conflict handling",
      }),
      responseIncludesAny: [
        "focus",
        "protect",
        "block",
        "alternative",
        "prefer",
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "CALENDAR"],
    },
    {
      type: "custom",
      name: "focus-block-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "focus-block conflict handling",
        includesAny: ["focus", "Sam", "10:30"],
      }),
    },
  ],
});
