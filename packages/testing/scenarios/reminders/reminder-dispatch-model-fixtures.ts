/** Supplies strict deterministic model fixtures for direct reminder API scenarios. */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioModelFixtureDeclaration,
} from "@elizaos/testing";

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

/** Remove only this scenario's definitions after its final assertions. */
export function cleanupReminderDefinitions(title: string) {
  return {
    type: "custom" as const,
    name: `remove reminder fixture: ${title}`,
    async apply({ runtime }: ScenarioContext): Promise<void> {
      if (!runtime) throw new Error("Reminder cleanup requires a live runtime");
      const { LifeOpsService } = await import(
        "@elizaos/plugin-personal-assistant/lifeops/service"
      );
      const service = new LifeOpsService(runtime as IAgentRuntime);
      for (const { definition } of await service.listDefinitions()) {
        if (definition.title === title)
          await service.deleteDefinition(definition.id);
      }
    },
  };
}
