/** Supplies strict deterministic model fixtures for direct reminder API scenarios. */

import type { ScenarioModelFixtureDeclaration } from "@elizaos/scenario-runner/schema";

export function reminderDispatchModelFixtures(
  maximumModelCalls: number,
): ScenarioModelFixtureDeclaration {
  return {
    mode: "fixtures",
    fixtures: [
      {
        name: "reminder-dispatch-body",
        match: {
          modelType: "TEXT_SMALL",
          prompt: {
            pattern:
              "\\nCharacter voice:\\n[\\s\\S]*\\nCurrent reminder:\\n[\\s\\S]*\\nRecent conversation:\\n[\\s\\S]*\\nOther reminders around this time:\\n[\\s\\S]*\\nReminder text:\\s*$",
          },
        },
        response: { text: "Heads up: your reminder is due." },
        cardinality: { min: 1, max: maximumModelCalls },
      },
      {
        name: "reminder-dispatch-title",
        match: {
          modelType: "TEXT_SMALL",
          prompt: {
            pattern:
              "\\nMessage body:\\n[\\s\\S]*\\n\\nFired at:[\\s\\S]*\\n\\nTitle:\\s*$",
          },
        },
        response: { text: "Reminder" },
        cardinality: { min: 1, max: maximumModelCalls },
      },
    ],
  };
}
