import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "calendar.defend-time.overlap-refuses",
  title:
    "Agent refuses to schedule during a blackout and suggests alternatives",
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
      title: "LifeOps Calendar Defend Time Overlap Refuses",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-deep-work-blackout",
      apply: seedCalendarCache({
        events: [
          {
            id: "calendar-deep-work-blackout",
            title: "Deep work blackout",
            startOffsetMinutes: 24 * 60 + 60,
            durationMinutes: 90,
            metadata: { category: "deep-work" },
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-during-blackout",
      text: "Schedule a meeting with Alex tomorrow at 10am.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "blackout conflict handling",
      }),
      responseIncludesAny: [
        "blackout",
        "deep work",
        "protect",
        "alternative",
        "instead",
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
      name: "blackout-conflict-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "blackout conflict handling",
        includesAny: ["Alex", "10am", "deep work"],
      }),
    },
  ],
});
