/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-discord.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

export const coreActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "name",
      description: "",
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "name",
      description: "",
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "channelState",
      description:
        "Provides information about the current Discord channel state, including whether it's a DM or group channel, channel name, and server name.",
      dynamic: true,
    },
    {
      name: "guildInfo",
      description:
        "Provides information about the current Discord server/guild including member count, creation date, channels, roles, and bot permissions.",
      dynamic: true,
    },
    {
      name: "voiceState",
      description:
        "Provides information about the voice state of the agent, including whether it is currently in a voice channel.",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "channelState",
      description:
        "Provides information about the current Discord channel state, including whether it's a DM or group channel, channel name, and server name.",
      dynamic: true,
    },
    {
      name: "guildInfo",
      description:
        "Provides information about the current Discord server/guild including member count, creation date, channels, roles, and bot permissions.",
      dynamic: true,
    },
    {
      name: "voiceState",
      description:
        "Provides information about the voice state of the agent, including whether it is currently in a voice channel.",
      dynamic: true,
    },
  ],
} as const;
export const coreEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;
export const allEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
