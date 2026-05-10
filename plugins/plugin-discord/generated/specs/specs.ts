/**
 * Auto-generated canonical action/provider docs for plugin-discord.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  position?: number;
  dynamic?: boolean;
};

export const coreActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "SETUP_CREDENTIALS",
        "PAIR_CONNECTOR",
        "CONNECT_ACCOUNT"
      ],
      "parameters": []
    }
  ]
} as const;
export const allActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "SETUP_CREDENTIALS",
        "PAIR_CONNECTOR",
        "CONNECT_ACCOUNT"
      ],
      "parameters": []
    }
  ]
} as const;
export const coreProvidersSpec = {
  "version": "1.0.0",
  "providers": []
} as const;
export const allProvidersSpec = {
  "version": "1.0.0",
  "providers": []
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
