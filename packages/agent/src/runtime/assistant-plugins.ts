/** The agent host's ordinary assistant composition. Core loads only supplied plugins. */
import type { Character, Plugin } from "@elizaos/core";
import {
  autonomyCapabilities,
  createAdvancedMemoryPlugin,
  createAdvancedPlanningPlugin,
  createAssistantPlugin,
  documentsPlugin,
  relationshipsPlugin,
  secretsCapability,
  trajectoriesPlugin,
  trustCapability,
} from "@elizaos/plugin-assistant";

const enabled = (value: unknown) => value === true || value === "true";

export function createAssistantPlugins(character: Character): Plugin[] {
  const settings = character.settings ?? {};
  return [
    createAssistantPlugin(),
    documentsPlugin,
    trajectoriesPlugin,
    {
      name: "relationships-services",
      description: "Relationship storage and follow-ups",
      services: relationshipsPlugin.services,
    },
    {
      name: "credentials-setup",
      description: "Credential setup and activation",
      ...secretsCapability,
    },
    ...(enabled(settings.ENABLE_AUTONOMY)
      ? [
          {
            name: "autonomy",
            description: "Autonomous assistant tasks",
            ...autonomyCapabilities,
          },
        ]
      : []),
    ...(enabled(settings.ENABLE_TRUST)
      ? [
          {
            name: "trust",
            description: "Trust assessment",
            ...trustCapability,
            init: async (_config, runtime) => trustCapability.init(runtime),
          } satisfies Plugin,
        ]
      : []),
    ...(character.advancedMemory ? [createAdvancedMemoryPlugin()] : []),
    ...(character.advancedPlanning ? [createAdvancedPlanningPlugin()] : []),
  ];
}
