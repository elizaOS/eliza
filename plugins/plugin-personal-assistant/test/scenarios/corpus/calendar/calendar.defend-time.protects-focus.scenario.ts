/** Scenario fixture for calendar defend time protects focus; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { seedCalendarCache } from "../../../scenario-support/lifeops-seeds.ts";

export default scenario({
  lane: "live-only",
  id: "calendar.defend-time.protects-focus",
  title: "Agent protects calendar focus blocks from meeting requests",
  domain: "calendar",
  evidenceScope: "model-behavior",
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
        acceptedActions: ["CALENDAR"],
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
      actionName: ["CALENDAR"],
    },
    {
      type: "custom",
      name: "focus-block-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "focus-block conflict handling",
        includesAny: ["focus", "Sam", "10:30"],
      }),
    },
  ],
});
